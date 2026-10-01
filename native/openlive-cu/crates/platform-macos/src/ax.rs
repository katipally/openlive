//! Reading and acting on the macOS accessibility tree.
//!
//! Element reads batch their attributes into one AXUIElementCopyMultipleAttributeValues
//! call, one IPC round trip per element instead of a dozen, which is most of
//! the cost of walking a window of a thousand elements.

use objc2_application_services::{AXCopyMultipleAttributeOptions, AXError, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{CFArray, CFBoolean, CFEqual, CFNumber, CFRange, CFRetained, CFString, CFType, CFURL, CGPoint, CGSize};
use openlive_cu_core::protocol::Rect;
use openlive_cu_core::tree::{NodeInfo, TreeSource};
use std::ptr::NonNull;

pub type Element = CFRetained<AXUIElement>;

pub fn cfstr(s: &str) -> CFRetained<CFString> {
    CFString::from_str(s)
}

pub fn attr(el: &AXUIElement, name: &str) -> Option<CFRetained<CFType>> {
    let mut out: *const CFType = std::ptr::null();
    // SAFETY: `out` is a valid out-pointer; a non-null result is +1 retained.
    let err = unsafe { el.copy_attribute_value(&cfstr(name), NonNull::from(&mut out)) };
    if err != AXError::Success || out.is_null() {
        return None;
    }
    // SAFETY: copied with a +1 retain count above.
    Some(unsafe { CFRetained::from_raw(NonNull::new_unchecked(out.cast_mut())) })
}

/// A string, number or boolean value as text; anything else is not text.
pub fn text(v: &CFType) -> Option<String> {
    if let Some(s) = v.downcast_ref::<CFString>() {
        return Some(s.to_string());
    }
    if let Some(b) = v.downcast_ref::<CFBoolean>() {
        return Some(if b.as_bool() { "1" } else { "0" }.into());
    }
    if let Some(n) = v.downcast_ref::<CFNumber>() {
        return n.as_i64().map(|i| i.to_string()).or_else(|| n.as_f64().map(|f| f.to_string()));
    }
    if let Some(u) = v.downcast_ref::<CFURL>() {
        return Some(u.string().to_string());
    }
    None
}

pub fn string(el: &AXUIElement, name: &str) -> Option<String> {
    attr(el, name).and_then(|v| text(&v))
}

pub fn element(el: &AXUIElement, name: &str) -> Option<Element> {
    attr(el, name).and_then(|v| v.downcast::<AXUIElement>().ok())
}

pub fn elements(el: &AXUIElement, name: &str) -> Vec<Element> {
    attr(el, name).map(|v| array_elements(&v)).unwrap_or_default()
}

/// An untyped CF array as one of CF objects, each still checked by downcast where it is used.
fn objects(array: &CFArray) -> &CFArray<CFType> {
    // SAFETY: every CFArray the AX API returns holds CF objects, and the layouts are identical.
    unsafe { &*(array as *const CFArray).cast::<CFArray<CFType>>() }
}

fn array_elements(v: &CFType) -> Vec<Element> {
    let Some(array) = v.downcast_ref::<CFArray>() else { return Vec::new() };
    objects(array).iter().filter_map(|item| item.downcast::<AXUIElement>().ok()).collect()
}

pub fn same(a: &AXUIElement, b: &AXUIElement) -> bool {
    CFEqual(Some(a), Some(b))
}

pub fn pid(el: &AXUIElement) -> Option<i32> {
    let mut pid: libc::pid_t = 0;
    // SAFETY: valid out-pointer.
    (unsafe { el.pid(NonNull::from(&mut pid)) } == AXError::Success).then_some(pid)
}

fn ax_value<T>(v: &CFType, kind: AXValueType, mut out: T) -> Option<T> {
    let v = v.downcast_ref::<AXValue>()?;
    // SAFETY: `out` has the layout `kind` names (CGPoint, CGSize or CFRange).
    unsafe { v.value(kind, NonNull::from(&mut out).cast()) }.then_some(out)
}

/// Desktop points, top-left origin, as AXPosition and AXSize report them.
pub fn frame(el: &AXUIElement) -> Option<Rect> {
    let (p, s) = (attr(el, "AXPosition")?, attr(el, "AXSize")?);
    let p = ax_value(&p, AXValueType::CGPoint, CGPoint::default())?;
    let s = ax_value(&s, AXValueType::CGSize, CGSize::default())?;
    Some(Rect { x: p.x, y: p.y, width: s.width, height: s.height })
}

pub fn actions(el: &AXUIElement) -> Vec<String> {
    let mut out: *const CFArray = std::ptr::null();
    // SAFETY: valid out-pointer; a non-null result is +1 retained.
    if unsafe { el.copy_action_names(NonNull::from(&mut out)) } != AXError::Success || out.is_null() {
        return Vec::new();
    }
    // SAFETY: retained above; the array holds CFStrings.
    let names = unsafe { CFRetained::from_raw(NonNull::new_unchecked(out.cast_mut())) };
    objects(&names).iter().filter_map(|n| n.downcast_ref::<CFString>().map(|s| s.to_string())).collect()
}

/// Runs `action` only when the element advertises it.
pub fn perform(el: &AXUIElement, action: &str) -> bool {
    actions(el).iter().any(|a| a == action) && unsafe { el.perform_action(&cfstr(action)) } == AXError::Success
}

pub fn settable(el: &AXUIElement, name: &str) -> bool {
    let mut out: u8 = 0;
    // SAFETY: valid out-pointer.
    (unsafe { el.is_attribute_settable(&cfstr(name), NonNull::from(&mut out)) } == AXError::Success) && out != 0
}

pub fn set(el: &AXUIElement, name: &str, value: &CFType) -> AXError {
    // SAFETY: plain attribute write.
    unsafe { el.set_attribute_value(&cfstr(name), value) }
}

pub fn set_bool(el: &AXUIElement, name: &str, value: bool) -> AXError {
    set(el, name, CFBoolean::new(value))
}

/// The selected text range in UTF-16 units.
pub fn selected_range(el: &AXUIElement) -> Option<(isize, isize)> {
    let v = attr(el, "AXSelectedTextRange")?;
    let r = ax_value(&v, AXValueType::CFRange, CFRange { location: 0, length: 0 })?;
    Some((r.location, r.length))
}

pub fn set_selected_range(el: &AXUIElement, location: isize, length: isize) -> bool {
    let mut range = CFRange { location, length };
    // SAFETY: `range` is a CFRange, the layout AXValueType::CFRange names.
    let Some(v) = (unsafe { AXValue::new(AXValueType::CFRange, NonNull::from(&mut range).cast()) }) else { return false };
    set(el, "AXSelectedTextRange", &v) == AXError::Success
}

// ── the tree ────────────────────────────────────────────────────────────────

/// Read in one batch per element. The order is the order `info` unpacks.
const TREE_ATTRS: &[&str] = &[
    "AXRole", "AXSubrole", "AXRoleDescription", "AXTitle", "AXDescription", "AXValue",
    "AXPlaceholderValue", "AXURL", "AXSelected", "AXEnabled", "AXExpanded",
];
/// Containers whose rows can run to thousands: only the visible ones are walked.
const ROW_CONTAINERS: &[&str] = &["AXTable", "AXOutline", "AXBrowser"];
const ROW_ROLES: &[&str] = &["AXRow", "AXOutlineRow", "AXCell"];
const TEXT_ROLES: &[&str] = &["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSlider"];
/// How many words of text a row or a link summary collects, and how deep it looks.
const SUMMARY_TEXTS: usize = 6;
const SUMMARY_DEPTH: usize = 3;

pub struct Source {
    names: CFRetained<CFArray<CFString>>,
}

impl Source {
    pub fn new() -> Self {
        let names: Vec<CFRetained<CFString>> = TREE_ATTRS.iter().map(|n| cfstr(n)).collect();
        Source { names: CFArray::from_retained_objects(&names) }
    }

    fn batch(&self, el: &AXUIElement) -> Vec<Option<CFRetained<CFType>>> {
        let mut out: *const CFArray = std::ptr::null();
        // SAFETY: valid out-pointer; a non-null result is +1 retained.
        let err = unsafe { el.copy_multiple_attribute_values(self.names.as_opaque(), AXCopyMultipleAttributeOptions(0), NonNull::from(&mut out)) };
        if err != AXError::Success || out.is_null() {
            return vec![None; TREE_ATTRS.len()];
        }
        // SAFETY: retained above. A missing attribute comes back as an AXValue holding an AXError.
        let values = unsafe { CFRetained::from_raw(NonNull::new_unchecked(out.cast_mut())) };
        let mut got: Vec<Option<CFRetained<CFType>>> = objects(&values)
            .iter()
            .map(|v| {
                // SAFETY: reading the type of a live AXValue.
                let missing = v.downcast_ref::<AXValue>().is_some_and(|a| unsafe { a.r#type() } == AXValueType::AXError);
                (!missing).then_some(v)
            })
            .collect();
        got.resize(TREE_ATTRS.len(), None);
        got
    }

    /// Up to `SUMMARY_TEXTS` pieces of static text under `el`, breadth-first.
    /// O(b^SUMMARY_DEPTH) reads for branching b, bounded by the count cap.
    fn texts(&self, el: &AXUIElement) -> Vec<String> {
        let mut out = Vec::new();
        let mut level = elements(el, "AXChildren");
        for _ in 0..SUMMARY_DEPTH {
            let mut next = Vec::new();
            for child in level {
                if out.len() >= SUMMARY_TEXTS {
                    return out;
                }
                if string(&child, "AXRole").as_deref() == Some("AXStaticText") {
                    if let Some(t) = string(&child, "AXValue").or_else(|| string(&child, "AXTitle")).filter(|t| !t.trim().is_empty()) {
                        out.push(t);
                    }
                } else {
                    next.extend(elements(&child, "AXChildren"));
                }
            }
            level = next;
        }
        out
    }
}

impl TreeSource for Source {
    type Node = Element;

    fn info(&mut self, el: &Element) -> NodeInfo {
        let v = self.batch(el);
        let s = |i: usize| v[i].as_deref().and_then(text);
        let b = |i: usize| v[i].as_deref().and_then(|x| x.downcast_ref::<CFBoolean>().map(|b| b.as_bool()));
        let role = s(0).unwrap_or_default();
        let subrole = s(1);
        let mut traits = Vec::new();
        if b(8) == Some(true) {
            traits.push("selected".into());
        }
        if b(10) == Some(true) {
            traits.push("expanded".into());
        }
        if b(9) == Some(false) {
            traits.push("disabled".into());
        }
        if TEXT_ROLES.contains(&role.as_str()) && settable(el, "AXValue") {
            traits.push("settable".into());
        }
        let secure = role == "AXSecureTextField" || subrole.as_deref() == Some("AXSecureTextField");
        let title = s(3);
        let link_text = (role == "AXLink" && title.is_none()).then(|| self.texts(el).into_iter().next()).flatten();
        let row_summary = ROW_ROLES.contains(&role.as_str()).then(|| self.texts(el).join(" ")).filter(|t| !t.is_empty());
        NodeInfo {
            role_description: s(2),
            title,
            label: s(4),
            value: if secure { None } else { s(5) },
            placeholder: s(6),
            url: s(7),
            link_text,
            row_summary,
            traits,
            actions: actions(el),
            secure,
            role,
        }
    }

    fn children(&mut self, el: &Element, info: &NodeInfo) -> Vec<Element> {
        if ROW_CONTAINERS.contains(&info.role.as_str()) {
            let rows = elements(el, "AXVisibleRows");
            if !rows.is_empty() {
                return rows;
            }
        }
        elements(el, "AXChildren")
    }

    fn same(&self, a: &Element, b: &Element) -> bool {
        same(a, b)
    }
}
