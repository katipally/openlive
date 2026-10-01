//! UI Automation control types onto the AX role names the tree text speaks,
//! so a model reads `button`, `text field` and `row` whatever the OS.
//!
//! The description is set only where macOS's own English role description
//! differs from the spelled-out role (`AXStaticText` reads "text"), so the
//! words match the macOS backend's line for line.

/// UIA_*ControlTypeId, 50000 to 50040.
pub mod control {
    pub const BUTTON: i32 = 50000;
    pub const CALENDAR: i32 = 50001;
    pub const CHECK_BOX: i32 = 50002;
    pub const COMBO_BOX: i32 = 50003;
    pub const EDIT: i32 = 50004;
    pub const HYPERLINK: i32 = 50005;
    pub const IMAGE: i32 = 50006;
    pub const LIST_ITEM: i32 = 50007;
    pub const LIST: i32 = 50008;
    pub const MENU: i32 = 50009;
    pub const MENU_BAR: i32 = 50010;
    pub const MENU_ITEM: i32 = 50011;
    pub const PROGRESS_BAR: i32 = 50012;
    pub const RADIO_BUTTON: i32 = 50013;
    pub const SCROLL_BAR: i32 = 50014;
    pub const SLIDER: i32 = 50015;
    pub const SPINNER: i32 = 50016;
    pub const STATUS_BAR: i32 = 50017;
    pub const TAB: i32 = 50018;
    pub const TAB_ITEM: i32 = 50019;
    pub const TEXT: i32 = 50020;
    pub const TOOL_BAR: i32 = 50021;
    pub const TOOL_TIP: i32 = 50022;
    pub const TREE: i32 = 50023;
    pub const TREE_ITEM: i32 = 50024;
    pub const CUSTOM: i32 = 50025;
    pub const GROUP: i32 = 50026;
    pub const THUMB: i32 = 50027;
    pub const DATA_GRID: i32 = 50028;
    pub const DATA_ITEM: i32 = 50029;
    pub const DOCUMENT: i32 = 50030;
    pub const SPLIT_BUTTON: i32 = 50031;
    pub const WINDOW: i32 = 50032;
    pub const PANE: i32 = 50033;
    pub const HEADER: i32 = 50034;
    pub const HEADER_ITEM: i32 = 50035;
    pub const TABLE: i32 = 50036;
    pub const TITLE_BAR: i32 = 50037;
    pub const SEPARATOR: i32 = 50038;
    pub const SEMANTIC_ZOOM: i32 = 50039;
    pub const APP_BAR: i32 = 50040;
}

/// What the role mapping needs beyond the control type.
#[derive(Debug, Clone, Copy, Default)]
pub struct Hints<'a> {
    /// UIA FrameworkId: `Chrome` and `Gecko` mark web content.
    pub framework: &'a str,
    /// UIA HeadingLevel, 1 to 9, for text a page marks as a heading.
    pub heading: Option<u8>,
    /// The element scrolls (ScrollPattern), which makes a pane a scroll area.
    pub scrollable: bool,
}

/// The AX role and, where macOS words it differently, its description.
pub fn role(control_type: i32, hints: Hints) -> (&'static str, Option<&'static str>) {
    use control::*;
    if hints.heading.is_some() {
        return ("AXHeading", None);
    }
    match control_type {
        BUTTON | HEADER_ITEM => ("AXButton", None),
        CALENDAR => ("AXGroup", Some("calendar")),
        CHECK_BOX => ("AXCheckBox", None),
        COMBO_BOX => ("AXComboBox", None),
        EDIT => ("AXTextField", None),
        HYPERLINK => ("AXLink", None),
        IMAGE => ("AXImage", None),
        LIST_ITEM | DATA_ITEM => ("AXRow", None),
        LIST => ("AXList", None),
        MENU => ("AXMenu", None),
        MENU_BAR => ("AXMenuBar", None),
        MENU_ITEM => ("AXMenuItem", None),
        PROGRESS_BAR => ("AXProgressIndicator", None),
        RADIO_BUTTON => ("AXRadioButton", None),
        SCROLL_BAR => ("AXScrollBar", None),
        SLIDER => ("AXSlider", None),
        SPINNER => ("AXIncrementor", Some("stepper")),
        STATUS_BAR => ("AXGroup", Some("status bar")),
        TAB => ("AXTabGroup", None),
        TAB_ITEM => ("AXTab", Some("tab")),
        TEXT => ("AXStaticText", Some("text")),
        TOOL_BAR | APP_BAR => ("AXToolbar", None),
        TOOL_TIP => ("AXHelpTag", Some("help tag")),
        TREE => ("AXOutline", None),
        TREE_ITEM => ("AXOutlineRow", None),
        THUMB => ("AXValueIndicator", None),
        DATA_GRID | TABLE => ("AXTable", None),
        DOCUMENT if matches!(hints.framework, "Chrome" | "Gecko") => ("AXWebArea", Some("HTML content")),
        DOCUMENT => ("AXTextArea", Some("text entry area")),
        SPLIT_BUTTON => ("AXMenuButton", None),
        WINDOW => ("AXWindow", None),
        PANE if hints.scrollable => ("AXScrollArea", None),
        PANE | GROUP | CUSTOM | HEADER | TITLE_BAR | SEMANTIC_ZOOM => ("AXGroup", None),
        SEPARATOR => ("AXUnknown", None),
        _ => ("AXUnknown", None),
    }
}

/// UIA HeadingLevel_None is 80050; levels 1 to 9 follow it.
pub fn heading_level(raw: i32) -> Option<u8> {
    (80051..=80059).contains(&raw).then(|| (raw - 80050) as u8)
}

/// The AX action names an element's patterns stand for. The tree text and
/// `performSecondaryAction` share macOS's vocabulary, so `scroll down` means
/// the same on both. Invoke, Toggle and SelectionItem are what `click` does,
/// all spelled `AXPress`, which the tree does not list.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Patterns {
    pub invoke: bool,
    pub toggle: bool,
    pub select: bool,
    /// ExpandCollapse, and whether the element is expanded now.
    pub expand: Option<bool>,
    pub scroll_vertical: bool,
    pub scroll_horizontal: bool,
    /// IUIAutomationElement3, Windows 8.1 and later.
    pub context_menu: bool,
}

pub fn actions(p: Patterns) -> Vec<String> {
    let mut out = Vec::new();
    if p.invoke || p.toggle || p.select {
        out.push("AXPress");
    }
    match p.expand {
        Some(true) => out.push("AXCollapse"),
        Some(false) => out.push("AXExpand"),
        None => {}
    }
    if p.scroll_vertical {
        out.extend(["AXScrollUpByPage", "AXScrollDownByPage"]);
    }
    if p.scroll_horizontal {
        out.extend(["AXScrollLeftByPage", "AXScrollRightByPage"]);
    }
    if p.context_menu {
        out.push("AXShowMenu");
    }
    out.into_iter().map(String::from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use openlive_cu_core::tree::{pretty_action, role_text, NodeInfo};

    fn spoken(control_type: i32, hints: Hints) -> String {
        let (role, description) = role(control_type, hints);
        role_text(&NodeInfo { role: role.into(), role_description: description.map(String::from), ..Default::default() })
    }

    #[test]
    fn controls_read_as_the_macos_backend_words_them() {
        let none = Hints::default();
        assert_eq!(spoken(control::BUTTON, none), "button");
        assert_eq!(spoken(control::EDIT, none), "text field");
        assert_eq!(spoken(control::CHECK_BOX, none), "check box");
        assert_eq!(spoken(control::TEXT, none), "text");
        assert_eq!(spoken(control::LIST_ITEM, none), "row");
        assert_eq!(spoken(control::TAB_ITEM, none), "tab");
        assert_eq!(spoken(control::TREE_ITEM, none), "outline row");
        assert_eq!(spoken(control::HYPERLINK, none), "link");
        assert_eq!(spoken(control::GROUP, none), "container");
        assert_eq!(spoken(control::DOCUMENT, none), "text entry area");
        assert_eq!(spoken(control::DOCUMENT, Hints { framework: "Chrome", ..none }), "HTML content");
        assert_eq!(spoken(control::PANE, Hints { scrollable: true, ..none }), "scroll area");
        assert_eq!(spoken(control::TEXT, Hints { heading: Some(2), ..none }), "heading");
    }

    #[test]
    fn every_control_type_has_a_role() {
        for id in 50000..=50040 {
            let (role, _) = role(id, Hints::default());
            assert!(role.starts_with("AX"), "{id}");
        }
        assert_eq!(role(12345, Hints::default()).0, "AXUnknown");
    }

    #[test]
    fn heading_levels() {
        assert_eq!(heading_level(80050), None);
        assert_eq!(heading_level(80051), Some(1));
        assert_eq!(heading_level(80059), Some(9));
        assert_eq!(heading_level(0), None);
    }

    #[test]
    fn patterns_read_as_macos_action_names() {
        let p = Patterns { toggle: true, expand: Some(false), scroll_vertical: true, context_menu: true, ..Default::default() };
        let names = actions(p);
        assert_eq!(names, ["AXPress", "AXExpand", "AXScrollUpByPage", "AXScrollDownByPage", "AXShowMenu"]);
        let spoken: Vec<String> = names.iter().map(|a| pretty_action(a)).collect();
        assert_eq!(spoken, ["press", "expand", "scroll up", "scroll down", "show menu"]);
        assert_eq!(actions(Patterns { expand: Some(true), ..Default::default() }), ["AXCollapse"]);
        assert!(actions(Patterns::default()).is_empty());
    }
}
