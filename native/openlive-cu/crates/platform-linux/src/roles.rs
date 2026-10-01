//! AT-SPI roles, states and actions onto the AX vocabulary the tree text
//! speaks, so a model reads `button`, `text field` and `row` whatever the OS.
//!
//! The description is set only where macOS's own English role description
//! differs from the spelled-out role (`AXStaticText` reads "text"), so the
//! words match the macOS and Windows backends line for line. Action names
//! follow Orca's Linux runtime (MIT, Copyright (c) 2026 Lovecast Inc.; see
//! THIRD_PARTY_NOTICES): toolkits name a press `click`, `press`, `activate`,
//! `jump` or `toggle`, and all of them are what `click` does.

use atspi_common::{Role, State, StateSet};
use openlive_cu_core::tree::NodeInfo;
use std::collections::HashMap;

/// ATSPI_ROLE_SWITCH, newer than the roles atspi-common names.
const ROLE_SWITCH: u32 = 130;

/// The interfaces an object implements, from `GetInterfaces`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Ifaces {
    pub action: bool,
    pub component: bool,
    pub text: bool,
    pub editable_text: bool,
    pub value: bool,
    pub selection: bool,
    pub hyperlink: bool,
}

impl Ifaces {
    pub fn from_names(names: &[String]) -> Self {
        let mut i = Ifaces::default();
        for n in names {
            match n.strip_prefix("org.a11y.atspi.").unwrap_or(n) {
                "Action" => i.action = true,
                "Component" => i.component = true,
                "Text" => i.text = true,
                "EditableText" => i.editable_text = true,
                "Value" => i.value = true,
                "Selection" => i.selection = true,
                "Hyperlink" => i.hyperlink = true,
                _ => {}
            }
        }
        i
    }
}

/// Everything one line of tree text needs, read off one object.
#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub role: u32,
    pub states: StateSet,
    pub ifaces: Ifaces,
    pub name: String,
    pub description: String,
    pub child_count: i32,
    pub attributes: HashMap<String, String>,
    /// Raw action names, in the object's own order (the index `DoAction` takes).
    pub actions: Vec<String>,
    pub value: Option<f64>,
    pub text: Option<String>,
    pub uri: Option<String>,
}

pub fn role_of(raw: u32) -> Option<Role> {
    Role::try_from(raw).ok()
}

/// `GetState`'s two 32-bit words as a set. Bits newer than atspi-common are dropped.
pub fn states(words: &[u32]) -> StateSet {
    let bits = u64::from(words.first().copied().unwrap_or(0)) | u64::from(words.get(1).copied().unwrap_or(0)) << 32;
    let known = (0..64).map(|b| 1u64 << b).filter(|b| bits & b != 0 && StateSet::from_bits(*b).is_ok()).fold(0, |a, b| a | b);
    StateSet::from_bits(known).unwrap_or_default()
}

/// A top-level an application lists as one of its windows.
pub fn is_window(raw: u32) -> bool {
    use Role::*;
    matches!(role_of(raw), Some(Frame | Window | Dialog | Alert | FileChooser | ColorChooser | FontChooser))
}

/// The AX role and, where macOS words it differently, its description.
pub fn role(raw: u32, states: StateSet) -> (&'static str, Option<&'static str>) {
    use Role::*;
    if raw == ROLE_SWITCH {
        return ("AXCheckBox", Some("switch"));
    }
    let Some(r) = role_of(raw) else { return ("AXUnknown", None) };
    let editable = states.contains(State::Editable);
    match r {
        Frame | Window | DesktopFrame | InputMethodWindow => ("AXWindow", None),
        Dialog => ("AXWindow", Some("dialog")),
        Button | Arrow => ("AXButton", None),
        PushButtonMenu => ("AXMenuButton", None),
        ToggleButton => ("AXCheckBox", Some("toggle button")),
        CheckBox => ("AXCheckBox", None),
        RadioButton => ("AXRadioButton", None),
        ComboBox | Autocomplete if editable => ("AXComboBox", None),
        ComboBox | Autocomplete => ("AXPopUpButton", None),
        Entry | Editbar | PasswordText => ("AXTextField", None),
        Text if states.contains(State::MultiLine) => ("AXTextArea", Some("text entry area")),
        Text if editable => ("AXTextField", None),
        Text | Label | Static | AcceleratorLabel | Caption | Paragraph | Subscript | Superscript => ("AXStaticText", Some("text")),
        SpinButton => ("AXIncrementor", Some("stepper")),
        Heading => ("AXHeading", None),
        Link => ("AXLink", None),
        Image | Icon | DesktopIcon | Animation | ImageMap => ("AXImage", None),
        List | ListBox | DescriptionList => ("AXList", None),
        ListItem | TableRow => ("AXRow", None),
        Table => ("AXTable", None),
        Tree | TreeTable => ("AXOutline", None),
        TreeItem => ("AXOutlineRow", None),
        TableCell | RowHeader | TableRowHeader => ("AXCell", None),
        ColumnHeader | TableColumnHeader => ("AXButton", None),
        Menu | PopupMenu => ("AXMenu", None),
        MenuBar => ("AXMenuBar", None),
        MenuItem | CheckMenuItem | RadioMenuItem | TearoffMenuItem => ("AXMenuItem", None),
        PageTabList => ("AXTabGroup", None),
        PageTab => ("AXTab", Some("tab")),
        ProgressBar | LevelBar => ("AXProgressIndicator", None),
        Slider | Dial | Rating => ("AXSlider", None),
        ScrollBar => ("AXScrollBar", None),
        ScrollPane | Viewport => ("AXScrollArea", None),
        ToolBar => ("AXToolbar", None),
        StatusBar => ("AXGroup", Some("status bar")),
        ToolTip => ("AXHelpTag", Some("help tag")),
        Calendar => ("AXGroup", Some("calendar")),
        Alert | Notification | InfoBar => ("AXGroup", Some("alert")),
        DocumentWeb | DocumentFrame => ("AXWebArea", Some("HTML content")),
        DocumentText | DocumentEmail | DocumentSpreadsheet | DocumentPresentation => ("AXTextArea", Some("text entry area")),
        Terminal => ("AXTextArea", Some("terminal")),
        Separator | Extended | Invalid | RedundantObject => ("AXUnknown", None),
        _ => ("AXGroup", None),
    }
}

fn is_checkable(raw: u32) -> bool {
    raw == ROLE_SWITCH
        || matches!(role_of(raw), Some(Role::CheckBox | Role::ToggleButton | Role::RadioButton | Role::CheckMenuItem | Role::RadioMenuItem))
}

pub fn is_secure(f: &Facts) -> bool {
    role_of(f.role) == Some(Role::PasswordText)
}

/// An item whose one click selects it in its container, as on Windows: a list
/// row, a tree row or a tab. Its `activate` is the double click.
pub fn is_selectable_item(raw: u32) -> bool {
    matches!(role_of(raw), Some(Role::ListItem | Role::TableRow | Role::TreeItem | Role::PageTab | Role::TableCell))
}

/// Containers whose rows can run to thousands: only the ones showing are walked.
pub fn is_row_container(raw: u32) -> bool {
    matches!(role_of(raw), Some(Role::List | Role::ListBox | Role::Table | Role::TreeTable | Role::Tree))
}

pub fn is_row(raw: u32) -> bool {
    matches!(role_of(raw), Some(Role::ListItem | Role::TableRow | Role::TreeItem))
}

/// Whether the object's text content is worth a `GetText`: its value, or the
/// words a nameless label or paragraph carries.
pub fn wants_text(raw: u32, name_empty: bool) -> bool {
    use Role::*;
    match role_of(raw) {
        Some(PasswordText) => false,
        Some(Entry | Text | Terminal | Editbar | ComboBox | Autocomplete | DocumentText | DocumentEmail) => true,
        Some(Label | Static | Paragraph | Heading | Caption | TableCell | ListItem | Link | AcceleratorLabel | Section) => name_empty,
        _ => false,
    }
}

/// A toolkit's action name in the AX vocabulary the tree and
/// `performSecondaryAction` share, or the raw name when nothing maps.
pub fn ax_action(raw: &str, states: StateSet) -> String {
    let lower = raw.trim().to_lowercase().replace(['_', '-'], " ");
    let compact = lower.replace(' ', "");
    match compact.as_str() {
        "click" | "press" | "activate" | "jump" | "open" | "toggle" | "select" | "invoke" | "default" => "AXPress".into(),
        "expandorcontract" | "expandorcollapse" | "expand/collapse" | "expandcollapse" => {
            if states.contains(State::Expanded) { "AXCollapse".into() } else { "AXExpand".into() }
        }
        "expand" => "AXExpand".into(),
        "collapse" | "contract" => "AXCollapse".into(),
        "showmenu" | "menu" | "popup" | "showcontextmenu" | "contextmenu" => "AXShowMenu".into(),
        "increment" => "AXIncrement".into(),
        "decrement" => "AXDecrement".into(),
        "scrolltovisible" | "scrollto" => "AXScrollToVisible".into(),
        _ => raw.trim().into(),
    }
}

/// Each AX action once, in the order the object lists them.
pub fn actions(raw: &[String], states: StateSet) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for a in raw.iter().filter(|a| !a.trim().is_empty()) {
        let name = ax_action(a, states);
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// The raw action a left click carries out, best first.
pub fn press_index(raw: &[String]) -> Option<usize> {
    const ORDER: &[&str] = &["click", "press", "activate", "jump", "toggle", "open", "invoke", "select"];
    let lower: Vec<String> = raw.iter().map(|a| a.trim().to_lowercase()).collect();
    ORDER.iter().find_map(|want| lower.iter().position(|a| a == want))
}

/// The raw action behind an AX action name (or the raw name itself).
pub fn index_of(raw: &[String], wanted_ax: &str, states: StateSet) -> Option<usize> {
    if wanted_ax == "AXPress" {
        return press_index(raw);
    }
    raw.iter().position(|a| ax_action(a, states) == wanted_ax)
}

fn number(v: f64) -> String {
    format!("{v}")
}

/// One object's facts as the core's tree formatter reads them.
pub fn node_info(f: &Facts, row_summary: Option<String>) -> NodeInfo {
    let (role, description) = role(f.role, f.states);
    let s = f.states;
    let secure = is_secure(f);
    let nonempty = |v: &str| (!v.trim().is_empty()).then(|| v.to_owned());
    let checked = is_checkable(f.role).then(|| {
        if s.contains(State::Indeterminate) { "2" } else if s.contains(State::Checked) || s.contains(State::Pressed) { "1" } else { "0" }
    });
    let text = f.text.as_deref().and_then(nonempty);
    let value = checked.map(String::from).or_else(|| f.value.map(number)).or_else(|| if role == "AXLink" { None } else { text.clone() });

    let mut traits = Vec::new();
    if s.contains(State::Selected) {
        traits.push("selected".to_owned());
    }
    if s.contains(State::Expanded) {
        traits.push("expanded".to_owned());
    }
    let actionable = !f.actions.is_empty() || s.contains(State::Focusable);
    if actionable && !s.contains(State::Enabled) && !s.contains(State::Sensitive) {
        traits.push("disabled".to_owned());
    }
    let writable = (s.contains(State::Editable) && f.ifaces.editable_text) || (f.ifaces.value && !s.contains(State::ReadOnly) && f.ifaces.action);
    if matches!(role, "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSlider" | "AXIncrementor") && writable {
        traits.push("settable".to_owned());
    }
    NodeInfo {
        role: role.into(),
        role_description: description.map(String::from),
        title: nonempty(&f.name),
        label: nonempty(&f.description),
        value: if secure { None } else { value },
        placeholder: f.attributes.get("placeholder-text").and_then(|p| nonempty(p)),
        url: f.uri.as_deref().and_then(nonempty),
        link_text: if role == "AXLink" { text } else { None },
        row_summary,
        traits,
        actions: actions(&f.actions, s),
        secure,
    }
}

/// Executables whose tab strips are compacted to the selected tab.
pub const BROWSERS: &[&str] = &[
    "firefox", "firefox-esr", "firefox-bin", "chrome", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
    "brave", "brave-browser", "msedge", "microsoft-edge", "vivaldi", "vivaldi-bin", "opera", "librewolf", "zen", "zen-bin",
];

#[cfg(test)]
mod tests {
    use super::*;
    use openlive_cu_core::tree::{pretty_action, role_text};

    fn facts(role: Role, states: &[State]) -> Facts {
        let mut set = StateSet::empty();
        for s in states {
            set.insert(*s);
        }
        Facts { role: role as u32, states: set, ..Default::default() }
    }

    fn spoken(role: Role, states: &[State]) -> String {
        role_text(&node_info(&facts(role, states), None))
    }

    #[test]
    fn roles_read_as_the_macos_backend_words_them() {
        assert_eq!(spoken(Role::Button, &[]), "button");
        assert_eq!(spoken(Role::Entry, &[]), "text field");
        assert_eq!(spoken(Role::Text, &[State::Editable]), "text field");
        assert_eq!(spoken(Role::Text, &[State::MultiLine]), "text entry area");
        assert_eq!(spoken(Role::Label, &[]), "text");
        assert_eq!(spoken(Role::CheckBox, &[]), "check box");
        assert_eq!(spoken(Role::ListItem, &[]), "row");
        assert_eq!(spoken(Role::PageTab, &[]), "tab");
        assert_eq!(spoken(Role::TreeItem, &[]), "outline row");
        assert_eq!(spoken(Role::Link, &[]), "link");
        assert_eq!(spoken(Role::Panel, &[]), "container");
        assert_eq!(spoken(Role::DocumentWeb, &[]), "HTML content");
        assert_eq!(spoken(Role::ScrollPane, &[]), "scroll area");
        assert_eq!(spoken(Role::ComboBox, &[]), "pop up button");
        assert_eq!(spoken(Role::ComboBox, &[State::Editable]), "combo box");
        assert_eq!(role(ROLE_SWITCH, StateSet::empty()), ("AXCheckBox", Some("switch")));
        assert_eq!(role(9999, StateSet::empty()).0, "AXUnknown");
    }

    #[test]
    fn every_known_role_has_an_ax_role() {
        for raw in 0..=ROLE_SWITCH {
            assert!(role(raw, StateSet::empty()).0.starts_with("AX"), "{raw}");
        }
    }

    #[test]
    fn toolkit_actions_read_as_macos_action_names() {
        let raw: Vec<String> = ["click", "expand or contract", "showMenu", "customize"].map(String::from).into();
        let names = actions(&raw, StateSet::empty());
        assert_eq!(names, ["AXPress", "AXExpand", "AXShowMenu", "customize"]);
        let spoken: Vec<String> = names.iter().map(|a| pretty_action(a)).collect();
        assert_eq!(spoken, ["press", "expand", "show menu", "customize"]);
        assert_eq!(actions(&raw, StateSet::new(State::Expanded))[1], "AXCollapse");
        // Two toolkit names for one press collapse into one.
        assert_eq!(actions(&["press".into(), "activate".into()], StateSet::empty()), ["AXPress"]);
    }

    #[test]
    fn a_click_prefers_click_then_press_then_activate() {
        let raw: Vec<String> = ["activate", "press", "menu"].map(String::from).into();
        assert_eq!(press_index(&raw), Some(1));
        assert_eq!(press_index(&["Toggle".into()]), Some(0));
        assert_eq!(press_index(&["menu".into()]), None);
        assert_eq!(index_of(&raw, "AXShowMenu", StateSet::empty()), Some(2));
        assert_eq!(index_of(&raw, "AXPress", StateSet::empty()), Some(1));
    }

    #[test]
    fn states_become_values_and_traits() {
        let f = Facts { actions: vec!["toggle".into()], ..facts(Role::CheckBox, &[State::Checked, State::Enabled, State::Sensitive]) };
        let n = node_info(&f, None);
        assert_eq!(n.value.as_deref(), Some("1"));
        assert!(n.traits.is_empty());
        let off = node_info(&Facts { actions: vec!["click".into()], ..facts(Role::Button, &[State::Selected]) }, None);
        assert_eq!(off.traits, ["selected", "disabled"]);
        let field = Facts {
            ifaces: Ifaces { editable_text: true, text: true, ..Default::default() },
            text: Some("hello".into()),
            attributes: HashMap::from([("placeholder-text".to_owned(), "Search".to_owned())]),
            ..facts(Role::Entry, &[State::Editable, State::Enabled, State::Sensitive, State::Focusable])
        };
        let n = node_info(&field, None);
        assert_eq!((n.value.as_deref(), n.placeholder.as_deref()), (Some("hello"), Some("Search")));
        assert_eq!(n.traits, ["settable"]);
        let slider = Facts { value: Some(3.0), ..facts(Role::Slider, &[]) };
        assert_eq!(node_info(&slider, None).value.as_deref(), Some("3"));
    }

    #[test]
    fn never_carries_a_password() {
        let f = Facts { text: Some("hunter2".into()), ..facts(Role::PasswordText, &[]) };
        let n = node_info(&f, None);
        assert!(n.secure && n.value.is_none());
        assert!(!wants_text(Role::PasswordText as u32, true));
    }

    #[test]
    fn links_carry_their_address_and_text() {
        let f = Facts { uri: Some("https://x.dev".into()), text: Some("Docs".into()), ..facts(Role::Link, &[]) };
        let n = node_info(&f, None);
        assert_eq!((n.url.as_deref(), n.link_text.as_deref(), n.value.as_deref()), (Some("https://x.dev"), Some("Docs"), None));
    }

    #[test]
    fn state_words_become_a_set() {
        let set = states(&[1 << 12 | 1 << 1, 1 << 31]);
        assert!(set.contains(State::Focused) && set.contains(State::Active));
        assert_eq!(set.iter().count(), 2);
        assert!(states(&[]).is_empty());
    }

    #[test]
    fn interfaces_by_name() {
        let i = Ifaces::from_names(&["org.a11y.atspi.Accessible".into(), "org.a11y.atspi.Action".into(), "org.a11y.atspi.EditableText".into()]);
        assert!(i.action && i.editable_text && !i.text);
    }
}
