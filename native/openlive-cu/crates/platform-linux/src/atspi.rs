//! Reading and acting on AT-SPI trees over the accessibility bus.
//!
//! The walk asks a parent for its children in one `GetChildren` call, then
//! asks every child for its facts (role, states, interfaces, name and
//! attributes, then its actions, value and text) all at once, so a level of
//! the tree costs a few round trips in flight together rather than a dozen
//! per element in a row. Over the whole walk that is O(V) calls for V elements
//! visited, with wall time O(D) round trips for depth D. `Cache.GetItems`
//! would hand over a whole app in one reply, but it is unbounded (every open
//! document of an office suite) and GTK 4 does not implement it, so the walk
//! does not lean on it.

use crate::bus::{block, call, get, set};
use crate::roles::{self, Facts, Ifaces};
use atspi_common::{State, StateSet};
use futures_lite::future::zip;
use futures_util::future::join_all;
use openlive_cu_core::protocol::{ActionReport, Rect};
use openlive_cu_core::tree::{NodeInfo, TreeSource, MAX_DEPTH, MAX_FIELD_CHARS, MAX_NODES};
use openlive_cu_core::{CuError, ErrorCode};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};
use zbus::Connection;

const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
const ACTION: &str = "org.a11y.atspi.Action";
const COMPONENT: &str = "org.a11y.atspi.Component";
const TEXT: &str = "org.a11y.atspi.Text";
const EDITABLE: &str = "org.a11y.atspi.EditableText";
const VALUE: &str = "org.a11y.atspi.Value";
const SELECTION: &str = "org.a11y.atspi.Selection";
const HYPERLINK: &str = "org.a11y.atspi.Hyperlink";
const APPLICATION: &str = "org.a11y.atspi.Application";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const REGISTRY: &str = "org.a11y.atspi.Registry";
const ROOT: &str = "/org/a11y/atspi/accessible/root";
const NULL: &str = "/org/a11y/atspi/null";
/// ATSPI_COORD_TYPE_SCREEN.
const SCREEN: u32 = 0;
/// Past this many children only the first are fetched, one by one: a list
/// with a hundred thousand rows shows a few dozen.
const CHILD_LIMIT: i32 = 2 * MAX_NODES as i32;
/// How much text a row's summary collects, and how deep it looks. The other backends' numbers.
const SUMMARY_TEXTS: usize = 6;
const SUMMARY_DEPTH: usize = 3;

type Ref = (String, OwnedObjectPath);

/// One accessible object, with where the walk found it. Equal by bus name and
/// path alone; the parent and index ride along for selecting it later.
#[derive(Clone, Debug)]
pub struct Node(Rc<Obj>);

#[derive(Debug)]
struct Obj {
    bus: String,
    path: String,
    parent: Option<Node>,
    index: i32,
}

impl Node {
    fn new(bus: &str, path: &str, parent: Option<Node>, index: i32) -> Node {
        Node(Rc::new(Obj { bus: bus.to_owned(), path: path.to_owned(), parent, index }))
    }
    fn from_ref(r: &Ref, parent: Option<&Node>, index: i32) -> Option<Node> {
        let path = r.1.as_str();
        (!r.0.is_empty() && path != NULL).then(|| Node::new(&r.0, path, parent.cloned(), index))
    }
    /// Stands in for "the element that reads Focused" when the core's walk
    /// asks which line has focus, so focus is found as the walk passes it
    /// rather than by a second walk.
    pub fn focus_marker() -> Node {
        Node::new("", "", None, -1)
    }
    fn is_marker(&self) -> bool {
        self.0.bus.is_empty()
    }
    pub fn bus(&self) -> &str {
        &self.0.bus
    }
    pub fn path(&self) -> &str {
        &self.0.path
    }
}

impl PartialEq for Node {
    fn eq(&self, other: &Self) -> bool {
        self.0.bus == other.0.bus && self.0.path == other.0.path
    }
}
impl Eq for Node {}
impl Hash for Node {
    fn hash<H: Hasher>(&self, h: &mut H) {
        self.0.bus.hash(h);
        self.0.path.hash(h);
    }
}

async fn on<R: serde::de::DeserializeOwned + zbus::zvariant::Type>(conn: &Connection, n: &Node, iface: &str, method: &str, body: &(impl serde::Serialize + zbus::zvariant::DynamicType)) -> Result<R, String> {
    call(conn, n.bus(), n.path(), iface, method, body).await
}

async fn text_of(conn: &Connection, n: &Node, limit: i32) -> Option<String> {
    let count: i32 = get(conn, n.bus(), n.path(), TEXT, "CharacterCount").await.ok()?;
    if count <= 0 {
        return None;
    }
    on::<String>(conn, n, TEXT, "GetText", &(0i32, count.min(limit))).await.ok()
}

/// Everything a line of tree text needs, in two rounds of concurrent calls.
/// A call that fails leaves its part empty: an object that vanished mid-walk reads as an unknown one.
async fn facts(conn: &Connection, n: &Node) -> Facts {
    let ((role, states), (ifaces, (props, attributes))) = zip(
        zip(on::<u32>(conn, n, ACCESSIBLE, "GetRole", &()), on::<Vec<u32>>(conn, n, ACCESSIBLE, "GetState", &())),
        zip(
            on::<Vec<String>>(conn, n, ACCESSIBLE, "GetInterfaces", &()),
            zip(
                on::<HashMap<String, OwnedValue>>(conn, n, PROPERTIES, "GetAll", &(ACCESSIBLE,)),
                on::<HashMap<String, String>>(conn, n, ACCESSIBLE, "GetAttributes", &()),
            ),
        ),
    )
    .await;
    let mut props = props.unwrap_or_default();
    let mut prop = |k: &str| props.remove(k).and_then(|v| String::try_from(v).ok()).unwrap_or_default();
    let (name, description) = (prop("Name"), prop("Description"));
    let child_count = props.remove("ChildCount").and_then(|v| i32::try_from(v).ok()).unwrap_or(-1);
    let role = role.unwrap_or(0);
    let ifaces = Ifaces::from_names(&ifaces.unwrap_or_default());
    let wants_text = ifaces.text && roles::wants_text(role, name.trim().is_empty());
    let ((actions, value), (text, uri)) = zip(
        zip(
            async {
                if !ifaces.action {
                    return Vec::new();
                }
                on::<Vec<(String, String, String)>>(conn, n, ACTION, "GetActions", &()).await.map(|a| a.into_iter().map(|(name, ..)| name).collect()).unwrap_or_default()
            },
            async { if ifaces.value { get::<f64>(conn, n.bus(), n.path(), VALUE, "CurrentValue").await.ok() } else { None } },
        ),
        zip(
            async { if wants_text { text_of(conn, n, MAX_FIELD_CHARS as i32 + 1).await } else { None } },
            async { if ifaces.hyperlink { on::<String>(conn, n, HYPERLINK, "GetURI", &(0i32,)).await.ok() } else { None } },
        ),
    )
    .await;
    Facts {
        role,
        states: roles::states(&states.unwrap_or_default()),
        ifaces,
        name,
        description,
        child_count,
        attributes: attributes.unwrap_or_default(),
        actions,
        value,
        text,
        uri,
    }
}

async fn children(conn: &Connection, n: &Node, count: i32) -> Vec<Node> {
    if count == 0 {
        return Vec::new();
    }
    let refs: Vec<Ref> = if count <= CHILD_LIMIT {
        on::<Vec<Ref>>(conn, n, ACCESSIBLE, "GetChildren", &()).await.unwrap_or_default()
    } else {
        join_all((0..CHILD_LIMIT).map(|i| async move { on::<Ref>(conn, n, ACCESSIBLE, "GetChildAtIndex", &(i,)).await })).await.into_iter().map_while(Result::ok).collect()
    };
    refs.iter().enumerate().filter_map(|(i, r)| Node::from_ref(r, Some(n), i as i32)).collect()
}

async fn extents_of(conn: &Connection, n: &Node) -> Option<Rect> {
    let (x, y, w, h): (i32, i32, i32, i32) = on(conn, n, COMPONENT, "GetExtents", &(SCREEN,)).await.ok()?;
    (w > 0 && h > 0).then(|| Rect { x: f64::from(x), y: f64::from(y), width: f64::from(w), height: f64::from(h) })
}

/// A top-level window an application lists, as AT-SPI describes it.
#[derive(Debug, Clone)]
pub struct Frame {
    pub node: Node,
    pub app_name: String,
    pub pid: Option<i32>,
    pub title: String,
    /// Screen coordinates on X11. On Wayland a toolkit cannot know where its
    /// window is, so most report the origin as (0, 0); the size is right.
    pub extents: Option<Rect>,
    pub states: StateSet,
}

pub struct A11y {
    pub conn: Connection,
}

impl A11y {
    /// Every application's windows. Two levels of concurrent calls.
    pub fn frames(&self) -> Vec<Frame> {
        let conn = &self.conn;
        block(async {
            let root = Node::new(REGISTRY, ROOT, None, 0);
            let apps = children(conn, &root, -1).await;
            let per_app = join_all(apps.iter().map(|app| async move {
                let ((app_name, pid), kids) = zip(
                    zip(async { get::<String>(conn, app.bus(), app.path(), ACCESSIBLE, "Name").await.unwrap_or_default() }, crate::bus::pid_of(conn, app.bus())),
                    children(conn, app, -1),
                )
                .await;
                let seen = join_all(kids.iter().map(|k| zip(facts(conn, k), extents_of(conn, k)))).await;
                kids.into_iter()
                    .zip(seen)
                    .filter(|(_, (f, _))| roles::is_window(f.role))
                    .map(|(node, (f, extents))| Frame { node, app_name: app_name.clone(), pid, title: f.name, extents, states: f.states })
                    .collect::<Vec<_>>()
            }))
            .await;
            per_app.into_iter().flatten().collect()
        })
    }

    pub fn facts(&self, n: &Node) -> Facts {
        block(facts(&self.conn, n))
    }

    pub fn states(&self, n: &Node) -> StateSet {
        block(on::<Vec<u32>>(&self.conn, n, ACCESSIBLE, "GetState", &())).map(|s| roles::states(&s)).unwrap_or_default()
    }

    /// Screen coordinates, read now: the element may have moved since the tree was read.
    pub fn extents(&self, n: &Node) -> Option<Rect> {
        block(extents_of(&self.conn, n))
    }

    pub fn raw_actions(&self, n: &Node) -> Vec<String> {
        block(on::<Vec<(String, String, String)>>(&self.conn, n, ACTION, "GetActions", &())).map(|a| a.into_iter().map(|(name, ..)| name).collect()).unwrap_or_default()
    }

    pub fn do_action(&self, n: &Node, index: usize) -> bool {
        block(on::<bool>(&self.conn, n, ACTION, "DoAction", &(index as i32,))).unwrap_or(false)
    }

    pub fn grab_focus(&self, n: &Node) -> bool {
        block(on::<bool>(&self.conn, n, COMPONENT, "GrabFocus", &())).unwrap_or(false)
    }

    /// The toolkit an app is built with (`GTK`, `Qt`, `Chromium`, `Gecko`), from its application object.
    pub fn toolkit(&self, n: &Node) -> Option<String> {
        block(get::<String>(&self.conn, n.bus(), ROOT, APPLICATION, "ToolkitName")).ok()
    }

    /// The element with keyboard focus under `root`, breadth first, every level
    /// in one round of calls. Bounded by the tree caps.
    pub fn focused_in(&self, root: &Node) -> Option<Node> {
        let conn = &self.conn;
        block(async {
            let mut level = vec![root.clone()];
            let mut seen = 0;
            for _ in 0..MAX_DEPTH {
                if level.is_empty() || seen > MAX_NODES * 4 {
                    break;
                }
                seen += level.len();
                let looked = join_all(level.iter().map(|n| zip(on::<Vec<u32>>(conn, n, ACCESSIBLE, "GetState", &()), get::<i32>(conn, n.bus(), n.path(), ACCESSIBLE, "ChildCount")))).await;
                let mut next = Vec::new();
                for (n, (states, count)) in level.iter().zip(&looked) {
                    let s = roles::states(states.as_deref().unwrap_or_default());
                    if s.contains(State::Focused) {
                        return Some(n.clone());
                    }
                    // Only showing branches can hold what has focus.
                    if s.contains(State::Showing) || n == root {
                        next.push((n, *count.as_ref().unwrap_or(&-1)));
                    }
                }
                level = join_all(next.into_iter().map(|(n, c)| children(conn, n, c))).await.into_iter().flatten().collect();
            }
            None
        })
    }

    /// Select a list row, tree row or tab through its container's Selection,
    /// as one click does, and read its state back.
    pub fn select(&self, n: &Node) -> Option<ActionReport> {
        let parent = n.0.parent.as_ref()?;
        let selected = block(on::<bool>(&self.conn, parent, SELECTION, "SelectChild", &(n.0.index,))).ok()?;
        if !selected {
            return None;
        }
        Some(ran("SelectChild", self.states(n).contains(State::Selected)))
    }

    /// Run the raw action at `index`, reading back the state it should change.
    pub fn press(&self, n: &Node, index: usize, name: &str) -> Option<ActionReport> {
        let watched = StateSet::new(State::Checked | State::Pressed | State::Expanded | State::Selected).bits();
        let before = self.states(n).bits();
        if !self.do_action(n, index) {
            return None;
        }
        // A toggle, an expander or a selection shows its effect in its own states; a plain press shows none, and stays unverified.
        Some(ran(name, (before ^ self.states(n).bits()) & watched != 0))
    }

    /// A number into a Value, a boolean into a check box, text into
    /// EditableText, each read back. A password field does not read back.
    pub fn set_value(&self, n: &Node, index: usize, value: &str) -> Result<ActionReport, CuError> {
        let f = self.facts(n);
        let refused = |why: String| CuError::new(ErrorCode::ValueNotSettable, format!("element {index} refused the value ({why})"));
        if let (true, Ok(number)) = (f.ifaces.value, value.trim().parse::<f64>()) {
            block(set(&self.conn, n.bus(), n.path(), VALUE, "CurrentValue", Value::F64(number))).map_err(refused)?;
            let back: Option<f64> = block(get(&self.conn, n.bus(), n.path(), VALUE, "CurrentValue")).ok();
            return Ok(read_back("Value.CurrentValue", back.is_some_and(|b| (b - number).abs() < 1e-6), back.map(|b| b.to_string())));
        }
        let wanted = match value.trim() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        };
        let checkable = matches!(roles::role(f.role, f.states).0, "AXCheckBox" | "AXRadioButton" | "AXMenuItem") && roles::press_index(&f.actions).is_some();
        if let (true, Some(on)) = (checkable, wanted) {
            // Off, on, and for a three-state box indeterminate: at most two presses reach either end.
            for _ in 0..3 {
                let s = self.states(n);
                if (s.contains(State::Checked) || s.contains(State::Pressed)) == on {
                    return Ok(read_back("toggle", true, None));
                }
                let i = roles::press_index(&self.raw_actions(n)).ok_or_else(|| refused("it has no toggle action".into()))?;
                if !self.do_action(n, i) {
                    return Err(refused("the toggle failed".into()));
                }
            }
            return Ok(read_back("toggle", false, Some(if self.states(n).contains(State::Checked) { "1" } else { "0" }.into())));
        }
        if !f.ifaces.editable_text {
            return Err(CuError::new(ErrorCode::ValueNotSettable, format!("element {index} does not take a value; click into it and type instead")));
        }
        if !f.states.contains(State::Editable) {
            return Err(CuError::new(ErrorCode::ValueNotSettable, format!("element {index} is read-only")));
        }
        if !block(on::<bool>(&self.conn, n, EDITABLE, "SetTextContents", &(value,))).map_err(refused)? {
            return Err(refused("the app said no".into()));
        }
        if roles::is_secure(&f) {
            return Ok(ActionReport::new("accessibility", "EditableText.SetTextContents", false).with_detail("a password field does not read back; check the state below"));
        }
        let back = block(text_of(&self.conn, n, i32::MAX));
        Ok(read_back("EditableText.SetTextContents", back.as_deref() == Some(value), back))
    }

    /// Put `text` where the caret is in an editable element, over the
    /// selection if there is one, and read the inserted span back. `None` when
    /// the element does not take text this way, so the caller types instead.
    pub fn insert(&self, n: &Node, text: &str) -> Option<ActionReport> {
        let f = self.facts(n);
        if !(f.ifaces.editable_text && f.ifaces.text && f.states.contains(State::Editable)) {
            return None;
        }
        let conn = &self.conn;
        let count: i32 = block(get(conn, n.bus(), n.path(), TEXT, "CharacterCount")).ok()?;
        let caret: i32 = block(get(conn, n.bus(), n.path(), TEXT, "CaretOffset")).unwrap_or(count);
        let selections: i32 = block(on(conn, n, TEXT, "GetNSelections", &())).unwrap_or(0);
        let mut at = if (0..=count).contains(&caret) { caret } else { count };
        if selections > 0 {
            if let Ok((start, end)) = block(on::<(i32, i32)>(conn, n, TEXT, "GetSelection", &(0i32,))) {
                if start < end && block(on::<bool>(conn, n, EDITABLE, "DeleteText", &(start, end))).unwrap_or(false) {
                    at = start;
                }
            }
        }
        let len = text.chars().count() as i32;
        if !block(on::<bool>(conn, n, EDITABLE, "InsertText", &(at, text, len))).unwrap_or(false) {
            return None;
        }
        let _ = block(on::<bool>(conn, n, TEXT, "SetCaretOffset", &(at + len,)));
        if roles::is_secure(&f) {
            return Some(ActionReport::new("accessibility", "EditableText.InsertText", false).with_detail("a password field does not read back; check the state below"));
        }
        let back = block(on::<String>(conn, n, TEXT, "GetText", &(at, at + len))).ok();
        Some(read_back("EditableText.InsertText", back.as_deref() == Some(text), back))
    }

    /// Select all of an element's text, and read the selection back.
    pub fn select_all(&self, n: &Node) -> bool {
        let conn = &self.conn;
        let Ok(count) = block(get::<i32>(conn, n.bus(), n.path(), TEXT, "CharacterCount")) else { return false };
        let selections: i32 = block(on(conn, n, TEXT, "GetNSelections", &())).unwrap_or(0);
        let done = if selections > 0 {
            block(on::<bool>(conn, n, TEXT, "SetSelection", &(0i32, 0i32, count)))
        } else {
            block(on::<bool>(conn, n, TEXT, "AddSelection", &(0i32, count)))
        };
        done.unwrap_or(false) && block(on::<(i32, i32)>(conn, n, TEXT, "GetSelection", &(0i32,))).ok() == Some((0, count))
    }
}

pub const UNASSERTED: &str = "the element's own action ran; whether it did what was meant shows in the state below";

fn ran(name: &str, verified: bool) -> ActionReport {
    let report = ActionReport::new("accessibility", name, verified);
    if verified { report } else { report.with_detail(UNASSERTED) }
}

fn read_back(name: &str, verified: bool, now: Option<String>) -> ActionReport {
    let report = ActionReport::new("accessibility", name, verified);
    if verified { report } else { report.with_detail(format!("the element now reads {:?}", now.unwrap_or_default())) }
}

/// The tree of one window, for the core's formatter. Facts are fetched a
/// level at a time and kept for the walk, so `info` after `children` is free.
pub struct Source<'a> {
    pub a11y: &'a A11y,
    known: HashMap<Node, Rc<Facts>>,
}

impl<'a> Source<'a> {
    pub fn new(a11y: &'a A11y) -> Self {
        Source { a11y, known: HashMap::new() }
    }

    fn fetch(&mut self, nodes: &[Node]) {
        let missing: Vec<&Node> = nodes.iter().filter(|n| !self.known.contains_key(*n)).collect();
        if missing.is_empty() {
            return;
        }
        let conn = &self.a11y.conn;
        let got = block(join_all(missing.iter().map(|n| facts(conn, n))));
        for (n, f) in missing.into_iter().zip(got) {
            self.known.insert(n.clone(), Rc::new(f));
        }
    }

    pub fn facts_of(&mut self, n: &Node) -> Rc<Facts> {
        self.fetch(std::slice::from_ref(n));
        self.known[n].clone()
    }

    fn kids(&mut self, n: &Node) -> Vec<Node> {
        let count = self.facts_of(n).child_count;
        let kids = block(children(&self.a11y.conn, n, count));
        self.fetch(&kids);
        kids
    }

    /// Up to `SUMMARY_TEXTS` pieces of text under a nameless row, breadth first.
    /// O(b^SUMMARY_DEPTH) elements for branching b, bounded by the count cap.
    fn texts(&mut self, n: &Node) -> String {
        let mut out: Vec<String> = Vec::new();
        let mut level = self.kids(n);
        for _ in 0..SUMMARY_DEPTH {
            let mut next = Vec::new();
            for child in level {
                if out.len() >= SUMMARY_TEXTS {
                    return out.join(" ");
                }
                let f = self.facts_of(&child);
                let said = [Some(f.name.trim()), f.text.as_deref().map(str::trim)].into_iter().flatten().find(|t| !t.is_empty()).map(str::to_owned);
                match said {
                    Some(t) if !roles::is_secure(&f) => out.push(t),
                    _ => next.extend(self.kids(&child)),
                }
            }
            level = next;
        }
        out.join(" ")
    }
}

impl TreeSource for Source<'_> {
    type Node = Node;

    fn info(&mut self, n: &Node) -> NodeInfo {
        let f = self.facts_of(n);
        let summary = (roles::is_row(f.role) && f.name.trim().is_empty() && f.child_count != 0).then(|| self.texts(n)).filter(|t| !t.is_empty());
        roles::node_info(&f, summary)
    }

    fn children(&mut self, n: &Node, _: &NodeInfo) -> Vec<Node> {
        let role = self.facts_of(n).role;
        let kids = self.kids(n);
        if !roles::is_row_container(role) {
            return kids;
        }
        let showing: Vec<Node> = kids.iter().filter(|k| self.known[*k].states.contains(State::Showing)).cloned().collect();
        if showing.is_empty() { kids } else { showing }
    }

    fn same(&self, a: &Node, b: &Node) -> bool {
        let focused = |n: &Node| self.known.get(n).is_some_and(|f| f.states.contains(State::Focused));
        match (a.is_marker(), b.is_marker()) {
            (true, false) => focused(b),
            (false, true) => focused(a),
            _ => a == b,
        }
    }
}
