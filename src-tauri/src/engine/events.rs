//! mpv event thread -> Tauri events.
//!
//! * `engine://property` `{name, value}` for every observed property change; `time-pos` (and the
//!   other per-frame counters) are throttled to ~8 Hz, the latest value is flushed on pause / seek /
//!   end so the UI never shows a stale time.
//! * `engine://event` `{event, ...}` for the other mpv events (`file-loaded`, `end-file`, `seek`,
//!   `playback-restart`, `video-reconfig`, `shutdown`), in mpv's JSON-IPC shape.

use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// Properties that change with every frame and are rate limited.
pub const THROTTLED: &[&str] = &["time-pos", "demuxer-cache-time", "avsync", "estimated-vf-fps"];
pub const MIN_INTERVAL: Duration = Duration::from_millis(125); // 8 Hz

/// What to do with one mpv event.
#[derive(Debug, PartialEq)]
pub enum Out {
    Property(Value),
    Event(Value),
}

/// Pure throttling state machine (unit tested; the event thread owns one instance).
pub struct Throttle {
    last_emit: Vec<Option<Instant>>,
    pending: Vec<Option<Value>>,
}

impl Default for Throttle {
    fn default() -> Self {
        Throttle { last_emit: vec![None; THROTTLED.len()], pending: vec![None; THROTTLED.len()] }
    }
}

impl Throttle {
    /// Converts one mpv event (JSON from `mpv_event_to_node`) into zero or more outputs.
    pub fn process(&mut self, ev: &Value, now: Instant) -> Vec<Out> {
        let mut out = self.handle(ev, now);
        // trailing edge: a value held back by the rate limit is sent once its interval passed
        // (the event loop also calls this with Null every 100 ms while mpv is idle)
        out.extend(self.flush_due(now));
        out
    }

    fn flush_due(&mut self, now: Instant) -> Vec<Out> {
        let mut out = vec![];
        for (i, name) in THROTTLED.iter().enumerate() {
            let due = self.last_emit[i].is_none_or(|t| now.duration_since(t) >= MIN_INTERVAL);
            if due {
                if let Some(v) = self.pending[i].take() {
                    self.last_emit[i] = Some(now);
                    out.push(Out::Property(json!({"name": name, "value": v})));
                }
            }
        }
        out
    }

    fn handle(&mut self, ev: &Value, now: Instant) -> Vec<Out> {
        let kind = ev.get("event").and_then(Value::as_str).unwrap_or("");
        match kind {
            "property-change" => {
                let name = ev.get("name").and_then(Value::as_str).unwrap_or("");
                let value = ev.get("data").cloned().unwrap_or(Value::Null);
                let mut out = vec![];
                if let Some(i) = THROTTLED.iter().position(|p| *p == name) {
                    let due = self.last_emit[i].is_none_or(|t| now.duration_since(t) >= MIN_INTERVAL);
                    if due {
                        self.last_emit[i] = Some(now);
                        self.pending[i] = None;
                        out.push(Out::Property(json!({"name": name, "value": value})));
                    } else {
                        self.pending[i] = Some(value);
                    }
                } else {
                    // a state change: make the time shown with it exact
                    if matches!(name, "pause" | "eof-reached" | "seeking") {
                        out.extend(self.flush(now));
                    }
                    out.push(Out::Property(json!({"name": name, "value": value})));
                }
                out
            }
            "log-message" | "" => vec![],
            _ => {
                let mut out = vec![];
                if matches!(kind, "seek" | "playback-restart" | "end-file") {
                    out.extend(self.flush(now));
                }
                out.push(Out::Event(ev.clone()));
                out
            }
        }
    }

    /// Emits the throttled values that are still waiting.
    pub fn flush(&mut self, now: Instant) -> Vec<Out> {
        let mut out = vec![];
        for (i, name) in THROTTLED.iter().enumerate() {
            if let Some(v) = self.pending[i].take() {
                self.last_emit[i] = Some(now);
                out.push(Out::Property(json!({"name": name, "value": v})));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prop(name: &str, v: Value) -> Value {
        json!({"event": "property-change", "name": name, "data": v, "id": 1})
    }

    #[test]
    fn time_pos_is_limited_to_8_hz_and_flushed_on_pause() {
        let mut t = Throttle::default();
        let t0 = Instant::now();
        let mut emitted = 0;
        // 26 events per second for 2 seconds, as measured in the spike
        for i in 0..52u64 {
            let now = t0 + Duration::from_millis(i * 1000 / 26);
            emitted += t.process(&prop("time-pos", json!(i as f64 / 26.0)), now).len();
        }
        assert!((14..=17).contains(&emitted), "emitted {emitted} in 2 s");
        // pause flushes the newest time first, then the pause change
        let out = t.process(&prop("pause", json!(true)), t0 + Duration::from_millis(2001));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], Out::Property(json!({"name": "time-pos", "value": 51.0 / 26.0})));
        assert_eq!(out[1], Out::Property(json!({"name": "pause", "value": true})));
    }

    #[test]
    fn held_back_value_is_sent_on_the_idle_tick() {
        let mut t = Throttle::default();
        let t0 = Instant::now();
        assert_eq!(t.process(&prop("time-pos", json!(1.0)), t0).len(), 1);
        assert!(t.process(&prop("time-pos", json!(2.0)), t0 + Duration::from_millis(50)).is_empty());
        assert!(t.process(&Value::Null, t0 + Duration::from_millis(100)).is_empty());
        let out = t.process(&Value::Null, t0 + Duration::from_millis(130));
        assert_eq!(out, vec![Out::Property(json!({"name": "time-pos", "value": 2.0}))]);
    }

    #[test]
    fn other_properties_and_events_pass_through() {
        let mut t = Throttle::default();
        let now = Instant::now();
        assert_eq!(t.process(&prop("aid", json!(2)), now), vec![Out::Property(json!({"name": "aid", "value": 2}))]);
        let ev = json!({"event": "file-loaded"});
        assert_eq!(t.process(&ev, now), vec![Out::Event(ev.clone())]);
        assert!(t.process(&json!({"event": "log-message", "text": "x"}), now).is_empty());
    }
}
