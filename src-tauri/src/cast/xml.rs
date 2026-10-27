//! Small bounded XML tree for UPnP answers (device description, SOAP responses).
//!
//! Safety: any `<!DOCTYPE` is rejected (so no DTD, no external or custom entities); only the five
//! predefined entities and character references are resolved. Depth and node count are capped;
//! the byte size is capped by the HTTP client before parsing.

use quick_xml::events::Event;
use quick_xml::Reader;

const MAX_DEPTH: usize = 32;
const MAX_NODES: usize = 4000;

#[derive(Debug, Default, Clone)]
pub struct Node {
    /// local name (namespace prefix dropped)
    pub name: String,
    pub text: String,
    pub children: Vec<Node>,
}

impl Node {
    pub fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name)
    }
    pub fn child_text(&self, name: &str) -> Option<&str> {
        self.child(name).map(|c| c.text.trim())
    }
    /// Depth-first search for the first node named `name`.
    pub fn find(&self, name: &str) -> Option<&Node> {
        if self.name == name {
            return Some(self);
        }
        self.children.iter().find_map(|c| c.find(name))
    }
    /// All nodes named `name` (depth-first).
    pub fn find_all<'a>(&'a self, name: &str, out: &mut Vec<&'a Node>) {
        if self.name == name {
            out.push(self);
        }
        for c in &self.children {
            c.find_all(name, out);
        }
    }
}

fn local(name: &str) -> String {
    name.rsplit(':').next().unwrap_or("").to_string()
}

fn entity(name: &str) -> Option<char> {
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        _ => return None,
    })
}

/// Parses `xml` into a root node (the document's single top element).
pub fn parse(xml: &str) -> Result<Node, String> {
    let mut r = Reader::from_str(xml);
    let mut stack: Vec<Node> = vec![Node::default()];
    let mut count = 0usize;
    loop {
        let ev = r.read_event().map_err(|e| format!("[cast-bad-xml] {e}"))?;
        match ev {
            Event::DocType(_) => return Err("[cast-bad-xml] DOCTYPE is not allowed".into()),
            Event::Start(e) => {
                count += 1;
                if stack.len() > MAX_DEPTH || count > MAX_NODES {
                    return Err("[cast-bad-xml] too deep or too large".into());
                }
                stack.push(Node { name: local(e.name().as_ref()), ..Default::default() });
            }
            Event::Empty(e) => {
                count += 1;
                if count > MAX_NODES {
                    return Err("[cast-bad-xml] too large".into());
                }
                let n = Node { name: local(e.name().as_ref()), ..Default::default() };
                stack.last_mut().unwrap().children.push(n);
            }
            Event::End(_) => {
                let n = stack.pop().unwrap();
                match stack.last_mut() {
                    Some(p) => p.children.push(n),
                    None => return Err("[cast-bad-xml] unbalanced".into()),
                }
            }
            Event::Text(t) => stack.last_mut().unwrap().text.push_str(&t),
            Event::CData(t) => stack.last_mut().unwrap().text.push_str(&t),
            Event::GeneralRef(g) => {
                let c = match g.resolve_char_ref().map_err(|e| format!("[cast-bad-xml] {e}"))? {
                    Some(c) => c,
                    None => entity(&g).ok_or("[cast-bad-xml] unknown entity")?,
                };
                stack.last_mut().unwrap().text.push(c);
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 {
        return Err("[cast-bad-xml] unclosed element".into());
    }
    stack.pop().unwrap().children.into_iter().next().ok_or_else(|| "[cast-bad-xml] empty".into())
}

/// Escapes text for element content and attribute values.
pub fn escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => o.push(c),
        }
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cast_xml_tree_entities_and_refusals() {
        let n = parse(r#"<?xml version="1.0"?><s:Envelope xmlns:s="x"><s:Body><u:R xmlns:u="y"><A>a &amp; b &#x41;</A><B/></u:R></s:Body></s:Envelope>"#).unwrap();
        assert_eq!(n.name, "Envelope");
        assert_eq!(n.find("A").unwrap().text, "a & b A");
        assert!(n.find("B").is_some());
        // XXE / billion laughs: any DOCTYPE is refused before entities could be defined
        let xxe = r#"<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///c:/windows/win.ini">]><r>&x;</r>"#;
        assert!(parse(xxe).unwrap_err().contains("DOCTYPE"));
        assert!(parse("<r>&custom;</r>").unwrap_err().contains("entity"));
        let deep = "<a>".repeat(40) + &"</a>".repeat(40);
        assert!(parse(&deep).is_err());
        assert!(parse("<a><b></a>").is_err());
        assert_eq!(escape("<a href=\"x\">&'"), "&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
    }
}
