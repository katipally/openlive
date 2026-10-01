//! Reading and acting on a window's UI Automation tree.
//!
//! Every element is fetched with a CacheRequest that carries all the
//! properties a line of tree text needs, and a parent's children come back in
//! one FindAllBuildCache call, so a walk costs one cross-process round trip per
//! expanded element instead of a dozen per element. Identity is the cached
//! RuntimeId, compared in this process, so the cycle guard costs no IPC at all.

use crate::roles::{self, control, Hints, Patterns};
use openlive_cu_core::protocol::{ActionReport, Rect};
use openlive_cu_core::tree::{NodeInfo, TreeSource};
use openlive_cu_core::{CuError, ErrorCode};
use std::rc::Rc;
use windows::core::{Interface, BSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Ole::{SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound};
use windows::Win32::System::Variant::{VARIANT, VT_ARRAY, VT_I4};
use windows::Win32::UI::Accessibility::*;

/// How long UIA waits to reach a provider, and for one call to answer. A hung
/// app otherwise holds a walk for UIA's default of 20 seconds per call.
const CONNECTION_TIMEOUT_MS: u32 = 2_000;
const TRANSACTION_TIMEOUT_MS: u32 = 5_000;
/// How many pieces of text a row's summary collects, and how deep it looks. The macOS backend's numbers.
const SUMMARY_TEXTS: usize = 6;
const SUMMARY_DEPTH: usize = 3;
/// Containers whose rows can run to thousands: only the ones on screen are walked.
const ROW_CONTAINERS: &[&str] = &["AXTable", "AXOutline", "AXList"];
const ROW_ROLES: &[&str] = &["AXRow", "AXOutlineRow", "AXCell"];
const TEXT_ROLES: &[&str] = &["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSlider"];

const PROPERTIES: &[UIA_PROPERTY_ID] = &[
    UIA_RuntimeIdPropertyId, UIA_ControlTypePropertyId, UIA_NamePropertyId, UIA_HelpTextPropertyId,
    UIA_IsEnabledPropertyId, UIA_IsPasswordPropertyId, UIA_IsOffscreenPropertyId, UIA_FrameworkIdPropertyId,
    UIA_HeadingLevelPropertyId, UIA_BoundingRectanglePropertyId,
    UIA_IsInvokePatternAvailablePropertyId, UIA_IsTogglePatternAvailablePropertyId, UIA_ToggleToggleStatePropertyId,
    UIA_IsSelectionItemPatternAvailablePropertyId, UIA_SelectionItemIsSelectedPropertyId,
    UIA_IsExpandCollapsePatternAvailablePropertyId, UIA_ExpandCollapseExpandCollapseStatePropertyId,
    UIA_IsScrollPatternAvailablePropertyId, UIA_ScrollVerticallyScrollablePropertyId, UIA_ScrollHorizontallyScrollablePropertyId,
    UIA_IsValuePatternAvailablePropertyId, UIA_ValueValuePropertyId, UIA_ValueIsReadOnlyPropertyId,
    UIA_IsRangeValuePatternAvailablePropertyId, UIA_RangeValueValuePropertyId, UIA_RangeValueIsReadOnlyPropertyId,
];

pub struct Uia {
    pub automation: IUIAutomation,
    cache: IUIAutomationCacheRequest,
    control_view: IUIAutomationCondition,
}

/// One element and its identity. Cheap to clone: a COM reference and a shared id.
#[derive(Clone)]
pub struct Node {
    pub el: IUIAutomationElement,
    rid: Rc<[i32]>,
}

fn com(e: windows::core::Error) -> CuError {
    CuError::internal(format!("UI Automation: {}", e.message()))
}

impl Uia {
    pub fn new() -> Result<Self, CuError> {
        // SAFETY: COM is initialised on this thread by the backend; every call is a plain UIA client call.
        unsafe {
            let automation: IUIAutomation = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
                .or_else(|_| CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER))
                .map_err(com)?;
            if let Ok(timed) = automation.cast::<IUIAutomation2>() {
                let _ = timed.SetConnectionTimeout(CONNECTION_TIMEOUT_MS);
                let _ = timed.SetTransactionTimeout(TRANSACTION_TIMEOUT_MS);
            }
            let cache = automation.CreateCacheRequest().map_err(com)?;
            for p in PROPERTIES {
                cache.AddProperty(*p).map_err(com)?;
            }
            let control_view = automation.ControlViewCondition().map_err(com)?;
            Ok(Uia { automation, cache, control_view })
        }
    }

    fn node(el: IUIAutomationElement) -> Node {
        let rid = runtime_id(&el);
        Node { el, rid: rid.into() }
    }

    pub fn window(&self, hwnd: HWND) -> Result<Node, CuError> {
        // SAFETY: a UIA client call on a window handle that may have closed; UIA reports that as an error.
        unsafe { self.automation.ElementFromHandleBuildCache(hwnd, &self.cache) }.map(Self::node).map_err(com)
    }

    pub fn focused(&self) -> Option<Node> {
        // SAFETY: a UIA client call.
        unsafe { self.automation.GetFocusedElementBuildCache(&self.cache) }.ok().map(Self::node)
    }

    fn children_of(&self, el: &IUIAutomationElement) -> Vec<Node> {
        // SAFETY: UIA client calls; indexes stay inside the array's reported length.
        unsafe {
            let Ok(array) = el.FindAllBuildCache(TreeScope_Children, &self.control_view, &self.cache) else { return Vec::new() };
            let n = array.Length().unwrap_or(0);
            (0..n).filter_map(|i| array.GetElement(i).ok()).map(Self::node).collect()
        }
    }

    /// Up to `SUMMARY_TEXTS` names of text under `el`, breadth-first.
    /// O(b^SUMMARY_DEPTH) elements for branching b, bounded by the count cap.
    fn texts(&self, el: &IUIAutomationElement) -> Vec<String> {
        let mut out = Vec::new();
        let mut level = self.children_of(el);
        for _ in 0..SUMMARY_DEPTH {
            let mut next = Vec::new();
            for child in level {
                if out.len() >= SUMMARY_TEXTS {
                    return out;
                }
                if int(&child.el, UIA_ControlTypePropertyId) == Some(control::TEXT) {
                    if let Some(t) = string(&child.el, UIA_NamePropertyId).filter(|t| !t.trim().is_empty()) {
                        out.push(t);
                    }
                } else {
                    next.extend(self.children_of(&child.el));
                }
            }
            level = next;
        }
        out
    }
}

// ── cached reads ────────────────────────────────────────────────────────────

/// A cached property; `None` when the element does not support it.
fn cached(el: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<VARIANT> {
    // SAFETY: a read from the element's own cache. Ignoring defaults turns "not supported" into a non-convertible value.
    unsafe { el.GetCachedPropertyValueEx(id, true) }.ok().filter(|v| !v.is_empty())
}

fn string(el: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<String> {
    cached(el, id).and_then(|v| BSTR::try_from(&v).ok()).map(|b| b.to_string()).filter(|s| !s.is_empty())
}

fn int(el: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<i32> {
    cached(el, id).and_then(|v| i32::try_from(&v).ok())
}

fn flag(el: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<bool> {
    cached(el, id).and_then(|v| bool::try_from(&v).ok())
}

fn number(el: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<f64> {
    cached(el, id).and_then(|v| f64::try_from(&v).ok())
}

/// The cached RuntimeId, an array of 32-bit ints; empty when there is none.
fn runtime_id(el: &IUIAutomationElement) -> Vec<i32> {
    let Some(v) = cached(el, UIA_RuntimeIdPropertyId) else { return Vec::new() };
    if v.vt() != (VT_ARRAY | VT_I4) {
        return Vec::new();
    }
    // SAFETY: a VT_ARRAY | VT_I4 variant holds a one-dimensional SAFEARRAY of i32, read within its bounds.
    unsafe {
        let array = v.Anonymous.Anonymous.Anonymous.parray;
        let (Ok(lo), Ok(hi)) = (SafeArrayGetLBound(array, 1), SafeArrayGetUBound(array, 1)) else { return Vec::new() };
        (lo..=hi)
            .filter_map(|i| {
                let mut out = 0i32;
                SafeArrayGetElement(array, &i, (&mut out as *mut i32).cast()).ok().map(|_| out)
            })
            .collect()
    }
}

/// The patterns an element offered when it was read.
pub fn patterns(el: &IUIAutomationElement) -> Patterns {
    let has = |id| flag(el, id) == Some(true);
    let expand_state = int(el, UIA_ExpandCollapseExpandCollapseStatePropertyId);
    let scrolls = has(UIA_IsScrollPatternAvailablePropertyId);
    Patterns {
        invoke: has(UIA_IsInvokePatternAvailablePropertyId),
        toggle: has(UIA_IsTogglePatternAvailablePropertyId),
        select: has(UIA_IsSelectionItemPatternAvailablePropertyId),
        expand: (has(UIA_IsExpandCollapsePatternAvailablePropertyId) && expand_state != Some(ExpandCollapseState_LeafNode.0))
            .then(|| expand_state == Some(ExpandCollapseState_Expanded.0)),
        scroll_vertical: scrolls && flag(el, UIA_ScrollVerticallyScrollablePropertyId) == Some(true),
        scroll_horizontal: scrolls && flag(el, UIA_ScrollHorizontallyScrollablePropertyId) == Some(true),
        context_menu: el.cast::<IUIAutomationElement3>().is_ok(),
    }
}

fn role_of(el: &IUIAutomationElement) -> (&'static str, Option<&'static str>) {
    let framework = string(el, UIA_FrameworkIdPropertyId).unwrap_or_default();
    let hints = Hints {
        framework: &framework,
        heading: int(el, UIA_HeadingLevelPropertyId).and_then(roles::heading_level),
        scrollable: flag(el, UIA_IsScrollPatternAvailablePropertyId) == Some(true),
    };
    roles::role(int(el, UIA_ControlTypePropertyId).unwrap_or(0), hints)
}

pub struct Source<'a> {
    pub uia: &'a Uia,
}

impl TreeSource for Source<'_> {
    type Node = Node;

    fn info(&mut self, node: &Node) -> NodeInfo {
        let el = &node.el;
        let (role, description) = role_of(el);
        let p = patterns(el);
        let secure = flag(el, UIA_IsPasswordPropertyId) == Some(true);
        let has = |id| flag(el, id) == Some(true);
        let text_value = has(UIA_IsValuePatternAvailablePropertyId).then(|| string(el, UIA_ValueValuePropertyId)).flatten();
        let range = has(UIA_IsRangeValuePatternAvailablePropertyId).then(|| number(el, UIA_RangeValueValuePropertyId)).flatten();
        // A check box reads 0, 1 or 2 (mixed), as AXValue does on macOS.
        let toggle = p.toggle.then(|| int(el, UIA_ToggleToggleStatePropertyId)).flatten();
        let value = text_value.clone().or_else(|| range.map(|r| r.to_string())).or_else(|| toggle.map(|t| t.to_string()));

        let mut traits = Vec::new();
        if flag(el, UIA_SelectionItemIsSelectedPropertyId) == Some(true) {
            traits.push("selected".into());
        }
        if p.expand == Some(true) {
            traits.push("expanded".into());
        }
        if flag(el, UIA_IsEnabledPropertyId) == Some(false) {
            traits.push("disabled".into());
        }
        let writable = (has(UIA_IsValuePatternAvailablePropertyId) && flag(el, UIA_ValueIsReadOnlyPropertyId) == Some(false))
            || (range.is_some() && flag(el, UIA_RangeValueIsReadOnlyPropertyId) == Some(false));
        if TEXT_ROLES.contains(&role) && writable {
            traits.push("settable".into());
        }
        let title = string(el, UIA_NamePropertyId);
        let row_summary = (ROW_ROLES.contains(&role) && title.is_none()).then(|| self.uia.texts(el).join(" ")).filter(|t| !t.is_empty());
        NodeInfo {
            role: role.into(),
            role_description: description.map(String::from),
            label: string(el, UIA_HelpTextPropertyId),
            // Chromium and Firefox give a link's address as its value.
            url: (role == "AXLink").then(|| text_value.clone()).flatten(),
            value: if secure || role == "AXLink" { None } else { value },
            placeholder: None,
            link_text: None,
            row_summary,
            traits,
            actions: roles::actions(p),
            secure,
            title,
        }
    }

    fn children(&mut self, node: &Node, info: &NodeInfo) -> Vec<Node> {
        let all = self.uia.children_of(&node.el);
        if !ROW_CONTAINERS.contains(&info.role.as_str()) {
            return all;
        }
        let visible: Vec<Node> = all.iter().filter(|c| flag(&c.el, UIA_IsOffscreenPropertyId) != Some(true)).cloned().collect();
        if visible.is_empty() { all } else { visible }
    }

    fn same(&self, a: &Node, b: &Node) -> bool {
        !a.rid.is_empty() && a.rid == b.rid
    }
}

// ── live calls, for actions ─────────────────────────────────────────────────

/// Desktop pixels, read now: the element may have moved since the tree was read.
pub fn bounds(el: &IUIAutomationElement) -> Option<Rect> {
    // SAFETY: a UIA client call.
    let r = unsafe { el.CurrentBoundingRectangle() }.ok()?;
    let rect = Rect { x: f64::from(r.left), y: f64::from(r.top), width: f64::from(r.right - r.left), height: f64::from(r.bottom - r.top) };
    (rect.width > 0.0 && rect.height > 0.0).then_some(rect)
}

fn pattern<T: Interface>(el: &IUIAutomationElement, id: UIA_PATTERN_ID) -> Option<T> {
    // SAFETY: a UIA client call; the pattern interface matches its id.
    unsafe { el.GetCurrentPatternAs::<T>(id) }.ok()
}

pub const UNASSERTED: &str = "the element's own action ran; whether it did what was meant shows in the state below";

fn ran(name: &str, verified: bool) -> ActionReport {
    let report = ActionReport::new("accessibility", name, verified);
    if verified { report } else { report.with_detail(UNASSERTED) }
}

/// What a left click means to the element: Invoke, Toggle, SelectionItem.Select,
/// then ExpandCollapse. Everything but Invoke is read back. `None` when the element has none of them.
pub fn press(el: &IUIAutomationElement) -> Option<ActionReport> {
    // SAFETY: UIA pattern calls on a live element; each failure falls through to the next pattern.
    unsafe {
        if let Some(p) = pattern::<IUIAutomationInvokePattern>(el, UIA_InvokePatternId) {
            if p.Invoke().is_ok() {
                return Some(ran("Invoke", false));
            }
        }
        if let Some(p) = pattern::<IUIAutomationTogglePattern>(el, UIA_TogglePatternId) {
            let before = p.CurrentToggleState().ok();
            if p.Toggle().is_ok() {
                return Some(ran("Toggle", before.is_some() && p.CurrentToggleState().ok() != before));
            }
        }
        if let Some(p) = pattern::<IUIAutomationSelectionItemPattern>(el, UIA_SelectionItemPatternId) {
            if p.Select().is_ok() {
                return Some(ran("Select", p.CurrentIsSelected().is_ok_and(|s| s.as_bool())));
            }
        }
        expand_or_collapse(el, None)
    }
}

/// `want`: `Some(true)` to expand, `Some(false)` to collapse, `None` to flip it.
pub fn expand_or_collapse(el: &IUIAutomationElement, want: Option<bool>) -> Option<ActionReport> {
    let p = pattern::<IUIAutomationExpandCollapsePattern>(el, UIA_ExpandCollapsePatternId)?;
    // SAFETY: UIA pattern calls on a live element.
    unsafe {
        let state = p.CurrentExpandCollapseState().ok()?;
        if state == ExpandCollapseState_LeafNode {
            return None;
        }
        let expand = want.unwrap_or(state != ExpandCollapseState_Expanded);
        let done = if expand { p.Expand() } else { p.Collapse() };
        done.ok()?;
        let now = p.CurrentExpandCollapseState().ok();
        let verified = if expand { now == Some(ExpandCollapseState_Expanded) || now == Some(ExpandCollapseState_PartiallyExpanded) } else { now == Some(ExpandCollapseState_Collapsed) };
        Some(ran(if expand { "Expand" } else { "Collapse" }, verified))
    }
}

/// The context menu, as a right click opens it. Windows 8.1 and later.
pub fn show_menu(el: &IUIAutomationElement) -> Option<ActionReport> {
    let el3 = el.cast::<IUIAutomationElement3>().ok()?;
    // SAFETY: a UIA client call.
    unsafe { el3.ShowContextMenu() }.ok()?;
    Some(ran("ShowContextMenu", false))
}

/// Scroll a page at a time, `pages` times, and read the position back.
pub fn scroll(el: &IUIAutomationElement, vertical: bool, forward: bool, pages: u32) -> Option<ActionReport> {
    let p = pattern::<IUIAutomationScrollPattern>(el, UIA_ScrollPatternId)?;
    let amount = if forward { ScrollAmount_LargeIncrement } else { ScrollAmount_LargeDecrement };
    // SAFETY: UIA pattern calls on a live element.
    unsafe {
        let position = || if vertical { p.CurrentVerticalScrollPercent() } else { p.CurrentHorizontalScrollPercent() }.ok();
        let before = position();
        for _ in 0..pages {
            let done = if vertical { p.Scroll(ScrollAmount_NoAmount, amount) } else { p.Scroll(amount, ScrollAmount_NoAmount) };
            done.ok()?;
        }
        let after = position();
        let name = match (vertical, forward) {
            (true, true) => "AXScrollDownByPage",
            (true, false) => "AXScrollUpByPage",
            (false, true) => "AXScrollRightByPage",
            (false, false) => "AXScrollLeftByPage",
        };
        Some(ran(name, before.is_some() && after.is_some() && after != before))
    }
}

/// A number into a RangeValue, a boolean into a Toggle, anything else into a
/// Value, and each read back. A password field does not read back.
pub fn set_value(el: &IUIAutomationElement, index: usize, value: &str) -> Result<ActionReport, CuError> {
    let refused = |e: windows::core::Error| CuError::new(ErrorCode::ValueNotSettable, format!("element {index} refused the value ({})", e.message()));
    // SAFETY: UIA pattern calls on a live element.
    unsafe {
        if let (Some(p), Ok(n)) = (pattern::<IUIAutomationRangeValuePattern>(el, UIA_RangeValuePatternId), value.trim().parse::<f64>()) {
            if !p.CurrentIsReadOnly().is_ok_and(|r| r.as_bool()) {
                p.SetValue(n).map_err(refused)?;
                let back = p.CurrentValue().ok();
                return Ok(read_back("RangeValue.SetValue", back.is_some_and(|b| (b - n).abs() < 1e-6), back.map(|b| b.to_string())));
            }
        }
        let wanted = match value.trim() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        };
        if let (Some(p), Some(on)) = (pattern::<IUIAutomationTogglePattern>(el, UIA_TogglePatternId), wanted) {
            // Off, on, and for a three-state box indeterminate: at most two toggles reach either end.
            for _ in 0..3 {
                if (p.CurrentToggleState().ok() == Some(ToggleState_On)) == on {
                    return Ok(read_back("Toggle", true, None));
                }
                p.Toggle().map_err(refused)?;
            }
            let now = p.CurrentToggleState().ok().map(|s| s.0.to_string());
            return Ok(read_back("Toggle", false, now));
        }
        let Some(p) = pattern::<IUIAutomationValuePattern>(el, UIA_ValuePatternId) else {
            return Err(CuError::new(ErrorCode::ValueNotSettable, format!("element {index} does not take a value; click into it and type instead")));
        };
        if p.CurrentIsReadOnly().is_ok_and(|r| r.as_bool()) {
            return Err(CuError::new(ErrorCode::ValueNotSettable, format!("element {index} is read-only")));
        }
        p.SetValue(&BSTR::from(value)).map_err(refused)?;
        let secure = el.CurrentIsPassword().is_ok_and(|s| s.as_bool());
        if secure {
            return Ok(ActionReport::new("accessibility", "Value.SetValue", false).with_detail("a password field does not read back; check the state below"));
        }
        let back = p.CurrentValue().ok().map(|b| b.to_string());
        Ok(read_back("Value.SetValue", back.as_deref() == Some(value), back))
    }
}

fn read_back(name: &str, verified: bool, now: Option<String>) -> ActionReport {
    let report = ActionReport::new("accessibility", name, verified);
    if verified { report } else { report.with_detail(format!("the element now reads {:?}", now.unwrap_or_default())) }
}

/// Ask UIA to focus a window: providers run in the app, so this can reach the
/// front where a background SetForegroundWindow is refused.
pub fn focus(uia: &Uia, hwnd: HWND) {
    // SAFETY: UIA client calls on a window that may have closed; failures are ignored.
    unsafe {
        if let Ok(el) = uia.automation.ElementFromHandle(hwnd) {
            let _ = el.SetFocus();
        }
    }
}
