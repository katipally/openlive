//! The accessibility tree as indexed text: one line per element worth naming,
//! indented by depth, numbered so a model can say "click 12" instead of
//! guessing pixels.
//!
//! Adapted from Orca's SnapshotRendering.swift and TreeRenderer
//! (https://github.com/stablyai/orca, MIT, Copyright (c) 2026 Lovecast Inc.;
//! see THIRD_PARTY_NOTICES). Roles use the macOS AX vocabulary (`AXButton`,
//! `AXRow`, ...); the Windows and Linux backends map UIA control types and
//! AT-SPI roles onto it, so one formatter and one prompt serve every platform.

/// What a backend reads off one element. Strings are raw; this module cleans them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NodeInfo {
    pub role: String,
    pub role_description: Option<String>,
    pub title: Option<String>,
    /// AXDescription, UIA Name/HelpText, AT-SPI description.
    pub label: Option<String>,
    pub value: Option<String>,
    pub placeholder: Option<String>,
    pub url: Option<String>,
    /// For a link: the first text inside it.
    pub link_text: Option<String>,
    /// For a row or a cell: the text inside it, joined.
    pub row_summary: Option<String>,
    /// `selected`, `disabled`, `expanded`, ...
    pub traits: Vec<String>,
    /// Raw action names (`AXPress`, `AXShowMenu`, ...).
    pub actions: Vec<String>,
    /// A password field. Its value is never rendered.
    pub secure: bool,
}

/// A tree a backend can walk. `same` guards against the cycles some apps' trees contain.
pub trait TreeSource {
    /// Cheap to clone: a retained handle, not a copy of the element.
    type Node: Clone;
    fn info(&mut self, node: &Self::Node) -> NodeInfo;
    fn children(&mut self, node: &Self::Node, info: &NodeInfo) -> Vec<Self::Node>;
    fn same(&self, a: &Self::Node, b: &Self::Node) -> bool;
}

/// Big enough for a busy app window, small enough to stay well under a turn's budget.
pub const MAX_NODES: usize = 1200;
pub const MAX_DEPTH: usize = 64;
/// One attribute that runs on (a whole document in a text area) is cut here.
pub const MAX_FIELD_CHARS: usize = 300;
/// A tab strip with at least this many tabs shows only the selected one.
const TAB_COMPACTION_MIN: usize = 10;

pub struct Rendered<N> {
    pub lines: Vec<String>,
    /// `records[i]` is the element labelled `i`.
    pub records: Vec<N>,
    pub focused: Option<usize>,
    focused_line: Option<String>,
    pub truncated: bool,
}

/// Walk from `root`, numbering every element worth a line.
///
/// O(N * D) attribute reads for N <= MAX_NODES rendered elements at depth
/// D <= MAX_DEPTH: the cycle guard compares each element with its ancestors.
/// Elided containers do not count toward N, so a deep run of anonymous groups
/// costs reads without lines; the depth cap bounds that too.
pub fn render<S: TreeSource>(src: &mut S, root: S::Node, focused: Option<&S::Node>, compact_tabs: bool) -> Rendered<S::Node> {
    let mut walk = Walk { src, focused, compact_tabs, out: Rendered { lines: Vec::new(), records: Vec::new(), focused: None, focused_line: None, truncated: false } };
    let mut ancestors = Vec::new();
    walk.visit(root, 0, &mut ancestors);
    walk.out
}

struct Walk<'a, S: TreeSource> {
    src: &'a mut S,
    focused: Option<&'a S::Node>,
    compact_tabs: bool,
    out: Rendered<S::Node>,
}

impl<S: TreeSource> Walk<'_, S> {
    fn visit(&mut self, node: S::Node, depth: usize, ancestors: &mut Vec<S::Node>) {
        if self.out.records.len() >= MAX_NODES || depth >= MAX_DEPTH {
            self.out.truncated = true;
            return;
        }
        if ancestors.iter().any(|a| self.src.same(a, &node)) {
            return;
        }
        let info = self.src.info(&node);
        let children = self.src.children(&node, &info);
        if should_elide(&info) {
            ancestors.push(node);
            for child in children {
                self.visit(child, depth, ancestors);
            }
            ancestors.pop();
            return;
        }

        let index = self.out.records.len();
        let line = line(index, &info);
        if self.focused.is_some_and(|f| self.src.same(f, &node)) {
            self.out.focused = Some(index);
            self.out.focused_line = Some(line.clone());
        }
        self.out.lines.push(format!("{}{line}", "\t".repeat(depth)));
        self.out.records.push(node.clone());
        if should_suppress_children(&info) {
            return;
        }

        let (children, omitted) = if self.compact_tabs && is_tab_strip(&info) { self.compact(children) } else { (children, 0) };
        ancestors.push(node);
        for child in children {
            self.visit(child, depth + 1, ancestors);
        }
        ancestors.pop();
        if omitted > 0 {
            self.out.lines.push(format!("{}... {omitted} inactive tabs omitted", "\t".repeat(depth + 1)));
        }
    }

    /// Browsers list every open tab; past a handful only the selected one helps.
    fn compact(&mut self, children: Vec<S::Node>) -> (Vec<S::Node>, usize) {
        let infos: Vec<NodeInfo> = children.iter().map(|c| self.src.info(c)).collect();
        let tabs = infos.iter().filter(|i| is_tab(i)).count();
        if tabs < TAB_COMPACTION_MIN || !infos.iter().any(|i| is_tab(i) && is_selected(i)) {
            return (children, 0);
        }
        let kept: Vec<S::Node> = children.into_iter().zip(&infos).filter(|(_, i)| !is_tab(i) || is_selected(i)).map(|(c, _)| c).collect();
        let selected = infos.iter().filter(|i| is_tab(i) && is_selected(i)).count();
        (kept, tabs - selected)
    }
}

/// The whole text a model reads for one window.
pub fn tree_text(app: &str, app_id: Option<&str>, pid: i32, window_title: &str, rendered: &Rendered<impl Sized>) -> String {
    let id = app_id.map(|b| format!("{b}, ")).unwrap_or_default();
    let mut out = format!("App: {} ({id}pid {pid})\nWindow: \"{}\"\n\n", clean(Some(app)).unwrap_or_default(), clean(Some(window_title)).unwrap_or_default());
    for l in &rendered.lines {
        out.push_str(l);
        out.push('\n');
    }
    if rendered.truncated {
        out.push_str(&format!("... more elements not shown (limit {MAX_NODES} elements, {MAX_DEPTH} levels)\n"));
    }
    out.push('\n');
    match &rendered.focused_line {
        Some(l) => out.push_str(&format!("Focused: {l}")),
        None => out.push_str("Nothing in this window has keyboard focus."),
    }
    out
}

// ── heuristics ──────────────────────────────────────────────────────────────

/// Collapse line breaks, trim, cap the length, and call an empty string nothing.
pub fn clean(value: Option<&str>) -> Option<String> {
    let v = value?.replace(['\n', '\r'], " ");
    let v = v.trim();
    if v.is_empty() {
        return None;
    }
    if v.chars().count() <= MAX_FIELD_CHARS {
        return Some(v.to_owned());
    }
    Some(format!("{}…", v.chars().take(MAX_FIELD_CHARS).collect::<String>()))
}

fn display_name(n: &NodeInfo) -> Option<String> {
    if let Some(t) = clean(n.title.as_deref()) {
        return Some(t);
    }
    match n.role.as_str() {
        "AXLink" => {
            let text = clean(n.link_text.as_deref().or(n.label.as_deref()).or(n.value.as_deref()));
            match (text, clean(n.url.as_deref())) {
                (Some(t), Some(u)) => Some(format!("[{}]({u})", t.replace('\\', "\\\\").replace('[', "\\[").replace(']', "\\]"))),
                (t, _) => t,
            }
        }
        "AXWebArea" => clean(n.label.as_deref()).or_else(|| clean(n.value.as_deref())),
        "AXRow" | "AXCell" | "AXOutlineRow" => clean(n.row_summary.as_deref()).or_else(|| clean(n.label.as_deref())),
        _ => clean(n.label.as_deref()),
    }
}

/// The actions worth offering by name. Pressing, confirming and showing a menu
/// are what `click` already does.
fn meaningful_actions(n: &NodeInfo) -> Vec<&str> {
    const NOISY: &[&str] = &["AXPress", "AXShowDefaultUI", "AXShowAlternateUI", "AXShowMenu", "AXScrollToVisible", "AXConfirm", "AXRaise"];
    let vertical = n.actions.iter().any(|a| a == "AXScrollUpByPage" || a == "AXScrollDownByPage");
    n.actions.iter().map(String::as_str).filter(|a| {
        if NOISY.contains(a) {
            return false;
        }
        if (n.role == "AXMenu" || n.role == "AXMenuItem") && (*a == "AXCancel" || *a == "AXPick") {
            return false;
        }
        !(n.role == "AXScrollArea" && vertical && (*a == "AXScrollLeftByPage" || *a == "AXScrollRightByPage"))
    }).collect()
}

/// An anonymous container adds a level and says nothing: its children move up.
fn should_elide(n: &NodeInfo) -> bool {
    matches!(n.role.as_str(), "AXGroup" | "AXUnknown" | "")
        && display_name(n).is_none()
        && n.traits.is_empty()
        && meaningful_actions(n).is_empty()
}

const COMPACT_CONTROLS: &[&str] = &[
    "AXButton", "AXCheckBox", "AXComboBox", "AXDisclosureTriangle", "AXHeading", "AXMenuItem",
    "AXPopUpButton", "AXRadioButton", "AXStaticText", "AXTab",
];

/// A labelled control already says everything its children would.
fn should_suppress_children(n: &NodeInfo) -> bool {
    if n.role == "AXMenuBarItem" {
        return true;
    }
    let name = display_name(n);
    if n.role == "AXLink" && name.as_deref().is_some_and(|s| s.starts_with('[')) {
        return true;
    }
    let labelled = name.is_some() || clean(n.value.as_deref()).is_some();
    labelled && COMPACT_CONTROLS.contains(&n.role.as_str())
}

pub fn role_text(n: &NodeInfo) -> String {
    match n.role.as_str() {
        "AXGroup" | "AXUnknown" | "" => "container".into(),
        "AXLink" => "link".into(),
        "AXWebArea" => clean(n.role_description.as_deref()).unwrap_or_else(|| "html content".into()),
        "AXMenuBarItem" => String::new(),
        role => clean(n.role_description.as_deref()).map(|d| d.to_lowercase()).unwrap_or_else(|| {
            split_camel(role.strip_prefix("AX").unwrap_or(role)).to_lowercase()
        }),
    }
}

/// `AXScrollDownByPage` as `scroll down`, the name `performSecondaryAction` also accepts.
pub fn pretty_action(action: &str) -> String {
    if action == "AXZoomWindow" {
        return "zoom the window".into();
    }
    split_camel(&action.strip_prefix("AX").unwrap_or(action).replace("ByPage", "")).to_lowercase()
}

fn split_camel(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for c in s.chars() {
        if c.is_uppercase() && !out.is_empty() {
            out.push(' ');
        }
        out.push(c);
    }
    out
}

fn line(index: usize, n: &NodeInfo) -> String {
    let name = display_name(n);
    let role = role_text(n);
    let value = if n.secure { None } else { clean(n.value.as_deref()) };
    let mut line = if role.is_empty() { index.to_string() } else { format!("{index} {role}") };
    if !n.traits.is_empty() {
        line += &format!(" ({})", n.traits.join(", "));
    }
    if let Some(name) = &name {
        line += &format!(" {name}");
    }
    if n.role != "AXLink" {
        if let Some(d) = clean(n.label.as_deref()).filter(|d| Some(d) != name.as_ref()) {
            line += &format!(", Description: {d}");
        }
    }
    if let Some(v) = value.as_ref().filter(|v| Some(*v) != name.as_ref()) {
        let numeric_heading = role == "heading" && v.parse::<i64>().is_ok();
        if !numeric_heading {
            let inline = matches!(role.as_str(), "text" | "text entry area" | "scroll bar" | "value indicator");
            line += &if inline { format!(" {v}") } else { format!(", Value: {v}") };
        }
    }
    if n.secure {
        line += ", Value: (hidden)";
    }
    if let Some(p) = clean(n.placeholder.as_deref()).filter(|p| Some(p) != name.as_ref() && Some(p) != value.as_ref()) {
        line += &if name.is_none() && value.is_none() { format!(" Placeholder: {p}") } else { format!(", Placeholder: {p}") };
    }
    if let Some(r) = clean(n.row_summary.as_deref()).filter(|r| Some(r) != name.as_ref()) {
        line += &format!(", Text: {r}");
    }
    let actions = meaningful_actions(n);
    if !actions.is_empty() {
        line += &format!(", Secondary Actions: {}", actions.iter().map(|a| pretty_action(a)).collect::<Vec<_>>().join(", "));
    }
    line
}

fn is_tab_strip(n: &NodeInfo) -> bool {
    let lower = |v: &Option<String>| clean(v.as_deref()).unwrap_or_default().to_lowercase();
    role_text(n) == "scroll area" || n.role == "AXTabGroup" || [lower(&n.role_description), lower(&n.title), lower(&n.label)].iter().any(|s| s == "tab bar")
}

fn is_tab(n: &NodeInfo) -> bool {
    n.role == "AXTab" || n.role == "AXRadioButton" && clean(n.role_description.as_deref()).is_some_and(|d| d.eq_ignore_ascii_case("tab"))
}

fn is_selected(n: &NodeInfo) -> bool {
    n.traits.iter().any(|t| t == "selected") || clean(n.value.as_deref()).as_deref() == Some("1")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tree held in a vector: node ids index `nodes`, `kids` names each one's children.
    struct Fake {
        nodes: Vec<NodeInfo>,
        kids: Vec<Vec<usize>>,
        reads: usize,
    }

    impl TreeSource for Fake {
        type Node = usize;
        fn info(&mut self, n: &usize) -> NodeInfo {
            self.reads += 1;
            self.nodes[*n].clone()
        }
        fn children(&mut self, n: &usize, _: &NodeInfo) -> Vec<usize> {
            self.kids[*n].clone()
        }
        fn same(&self, a: &usize, b: &usize) -> bool {
            a == b
        }
    }

    fn node(role: &str) -> NodeInfo {
        NodeInfo { role: role.into(), ..Default::default() }
    }

    fn named(role: &str, title: &str) -> NodeInfo {
        NodeInfo { title: Some(title.into()), ..node(role) }
    }

    #[test]
    fn indexes_indents_and_elides_anonymous_groups() {
        let mut f = Fake {
            nodes: vec![
                named("AXWindow", "Notes"),
                node("AXGroup"),
                NodeInfo { actions: vec!["AXPress".into()], ..named("AXButton", "Save") },
                NodeInfo { value: Some("hello\nworld".into()), placeholder: Some("Type".into()), ..node("AXTextArea") },
            ],
            kids: vec![vec![1], vec![2, 3], vec![], vec![]],
            reads: 0,
        };
        let r = render(&mut f, 0, Some(&3), false);
        assert_eq!(r.lines, vec![
            "0 window Notes",
            "\t1 button Save",
            "\t2 text area, Value: hello world, Placeholder: Type",
        ]);
        assert_eq!(r.records, vec![0, 2, 3]);
        assert_eq!(r.focused, Some(2));
        let text = tree_text("Notes", Some("com.apple.Notes"), 42, "Notes", &r);
        assert!(text.starts_with("App: Notes (com.apple.Notes, pid 42)\nWindow: \"Notes\"\n\n0 window Notes\n"));
        assert!(text.ends_with("Focused: 2 text area, Value: hello world, Placeholder: Type"));
    }

    #[test]
    fn never_renders_a_password() {
        let mut f = Fake { nodes: vec![NodeInfo { value: Some("hunter2".into()), secure: true, ..node("AXTextField") }], kids: vec![vec![]], reads: 0 };
        let r = render(&mut f, 0, None, false);
        assert!(!r.lines[0].contains("hunter2"));
        assert!(r.lines[0].contains("(hidden)"));
    }

    #[test]
    fn links_render_as_markdown_and_keep_their_children_quiet() {
        let mut f = Fake {
            nodes: vec![
                NodeInfo { link_text: Some("Docs [v2]".into()), url: Some("https://x.dev".into()), ..node("AXLink") },
                named("AXStaticText", "Docs"),
            ],
            kids: vec![vec![1], vec![]],
            reads: 0,
        };
        let r = render(&mut f, 0, None, false);
        assert_eq!(r.lines, vec!["0 link [Docs \\[v2\\]](https://x.dev)"]);
    }

    #[test]
    fn lists_secondary_actions_by_their_spoken_name() {
        let mut f = Fake {
            nodes: vec![NodeInfo { actions: vec!["AXPress".into(), "AXScrollDownByPage".into(), "AXScrollRightByPage".into()], ..node("AXScrollArea") }],
            kids: vec![vec![]],
            reads: 0,
        };
        assert_eq!(render(&mut f, 0, None, false).lines, vec!["0 scroll area, Secondary Actions: scroll down"]);
    }

    #[test]
    fn caps_nodes_and_depth() {
        // A chain deeper than the depth cap.
        let n = MAX_DEPTH + 5;
        let mut f = Fake { nodes: (0..n).map(|i| named("AXCell", &i.to_string())).collect(), kids: (0..n).map(|i| if i + 1 < n { vec![i + 1] } else { vec![] }).collect(), reads: 0 };
        let r = render(&mut f, 0, None, false);
        assert_eq!(r.records.len(), MAX_DEPTH);
        assert!(r.truncated);

        // A flat window wider than the node cap.
        let n = MAX_NODES + 50;
        let mut f = Fake { nodes: std::iter::once(named("AXWindow", "w")).chain((1..n).map(|_| named("AXButton", "b"))).collect(), kids: std::iter::once((1..n).collect()).chain((1..n).map(|_| vec![])).collect(), reads: 0 };
        let r = render(&mut f, 0, None, false);
        assert_eq!(r.records.len(), MAX_NODES);
        assert!(r.truncated);
        assert!(f.reads <= MAX_NODES + 1);
    }

    #[test]
    fn survives_a_cycle() {
        let mut f = Fake { nodes: vec![named("AXWindow", "w"), named("AXList", "l")], kids: vec![vec![1], vec![0]], reads: 0 };
        assert_eq!(render(&mut f, 0, None, false).lines.len(), 2);
    }

    #[test]
    fn compacts_a_long_tab_strip_to_the_selected_tab() {
        let mut nodes = vec![node("AXTabGroup")];
        let mut tabs = Vec::new();
        for i in 0..12 {
            let mut t = named("AXTab", &format!("Tab {i}"));
            if i == 3 {
                t.traits.push("selected".into());
            }
            tabs.push(nodes.len());
            nodes.push(t);
        }
        let kids = std::iter::once(tabs).chain((0..12).map(|_| vec![])).collect();
        let mut f = Fake { nodes, kids, reads: 0 };
        let r = render(&mut f, 0, None, true);
        assert_eq!(r.lines, vec!["0 tab group", "\t1 tab (selected) Tab 3", "\t... 11 inactive tabs omitted"]);
        assert_eq!(r.records, vec![0, 4]);
    }

    #[test]
    fn cuts_runaway_values() {
        let long = "x".repeat(MAX_FIELD_CHARS + 50);
        let c = clean(Some(&long)).unwrap();
        assert_eq!(c.chars().count(), MAX_FIELD_CHARS + 1);
        assert!(c.ends_with('…'));
    }

    #[test]
    fn pretty_actions() {
        assert_eq!(pretty_action("AXScrollDownByPage"), "scroll down");
        assert_eq!(pretty_action("AXShowMenu"), "show menu");
        assert_eq!(pretty_action("AXZoomWindow"), "zoom the window");
    }
}
