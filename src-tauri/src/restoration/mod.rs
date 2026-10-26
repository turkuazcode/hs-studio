//! Video restoration (Plan 12). V01: source inspection (`probe`) and the restoration recipe
//! (`recipe`). No processing pipeline yet (V03); the feature stays labelled "not ready"
//! (`video.aiRestore`) until V06.
//!
//! Commands:
//! - `restoration_probe(path)` → report + target options + suggested recipe + assessment + hash
//! - `restoration_recipe(path, recipe)` → normalised recipe + assessment + filter chain + hash
//!   (the report is re-measured when the file changed; cached by fingerprint otherwise)

pub mod probe;
pub mod recipe;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::actions::ffmpeg;
use probe::SourceReport;
use recipe::{Assessment, Recipe, Status, TargetOption};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecipeResponse {
    pub report: SourceReport,
    pub targets: Vec<TargetOption>,
    /// None when the file has no video stream
    pub recipe: Option<Recipe>,
    pub assessment: Assessment,
    /// ffmpeg `-vf` chain (input decoded with `-noautorotate`)
    pub filter: String,
    pub recipe_hash: String,
}

fn cache() -> &'static Mutex<HashMap<String, SourceReport>> {
    static C: OnceLock<Mutex<HashMap<String, SourceReport>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// Report for `path`; re-measured when size / modification time changed.
fn report_for(tools: &ffmpeg::Tools, path: &Path) -> Result<SourceReport, String> {
    let fp = probe::fingerprint(path)?;
    if let Some(r) = cache().lock().unwrap().get(&fp.path).filter(|r| r.source == fp) {
        return Ok(r.clone());
    }
    let r = probe::probe_source_with(tools, path, &|| false)?;
    let mut c = cache().lock().unwrap();
    if c.len() > 32 {
        c.clear();
    }
    c.insert(r.source.path.clone(), r.clone());
    Ok(r)
}

/// Assessment + filter check against this ffmpeg build + hash.
pub fn evaluate(tools: &ffmpeg::Tools, report: SourceReport, recipe: Option<Recipe>) -> RecipeResponse {
    let targets = report.video.as_ref().map(|v| recipe::targets(v.display_width, v.display_height)).unwrap_or_default();
    let Some(mut r) = recipe else {
        let assessment = Assessment { status: Status::Blocked, notices: vec![], blockers: vec!["no-video".into()] };
        return RecipeResponse { report, targets, recipe: None, assessment, filter: String::new(), recipe_hash: String::new() };
    };
    recipe::normalize(&mut r, &report);
    let mut assessment = recipe::assess(&r, &report);
    let filter = recipe::video_filter(&r);
    let missing = recipe::missing_filters(&filter, &probe::available_filters(tools));
    if !missing.is_empty() {
        assessment.blockers.extend(missing.into_iter().map(|f| format!("filter-missing:{f}")));
        assessment.status = Status::Blocked;
    }
    let recipe_hash = recipe::recipe_hash(&r, &report);
    RecipeResponse { report, targets, recipe: Some(r), assessment, filter, recipe_hash }
}

#[tauri::command]
pub async fn restoration_probe(path: String) -> Result<RecipeResponse, String> {
    crate::actions::blocking(move || {
        let tools = ffmpeg::locate()?;
        let report = report_for(&tools, Path::new(&path))?;
        let suggested = recipe::suggest(&report);
        Ok(evaluate(&tools, report, suggested))
    })
    .await
}

#[tauri::command]
pub async fn restoration_recipe(path: String, recipe: Recipe) -> Result<RecipeResponse, String> {
    crate::actions::blocking(move || {
        let tools = ffmpeg::locate()?;
        let report = report_for(&tools, Path::new(&path))?;
        Ok(evaluate(&tools, report, Some(recipe)))
    })
    .await
}

#[cfg(test)]
mod tests;
