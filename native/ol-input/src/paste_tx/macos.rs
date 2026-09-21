//! macOS lazy publish. The pasteboard holds a promise rather than the text,
//! and the provider callback is the receipt: it only fires when something
//! actually pulls the data.

use std::sync::Arc;
use std::time::Instant;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AnyThread, DefinedClass};
use objc2_app_kit::{
    NSPasteboard, NSPasteboardItem, NSPasteboardItemDataProvider, NSPasteboardType,
    NSPasteboardTypeString, NSPasteboardWriting,
};
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSString};

use super::Receipt;

struct Ivars {
    text: String,
    receipt: Arc<Receipt>,
    started: Instant,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this class has no
    // Drop impl.
    #[unsafe(super(NSObject))]
    #[ivars = Ivars]
    struct Provider;

    unsafe impl NSObjectProtocol for Provider {}

    unsafe impl NSPasteboardItemDataProvider for Provider {
        #[unsafe(method(pasteboard:item:provideDataForType:))]
        #[allow(non_snake_case)]
        fn pasteboard_item_provideDataForType(
            &self,
            _pasteboard: Option<&NSPasteboard>,
            item: &NSPasteboardItem,
            r#type: &NSPasteboardType,
        ) {
            let ivars = self.ivars();
            item.setString_forType(&NSString::from_str(&ivars.text), r#type);
            ivars.receipt.mark_read(ivars.started.elapsed());
        }
    }
);

/// Returns the change count the promise was published under. Comparing that
/// later is how ownership is checked: reading the pasteboard back would
/// fulfil this very promise from whatever thread asked.
pub fn publish(text: &str, receipt: Arc<Receipt>, started: Instant) -> Result<isize, String> {
    let provider = Provider::alloc().set_ivars(Ivars {
        text: text.to_string(),
        receipt,
        started,
    });
    let provider: Retained<Provider> = unsafe { msg_send![super(provider), init] };

    let item = NSPasteboardItem::new();
    let types = NSArray::from_slice(&[unsafe { NSPasteboardTypeString }]);
    if !item.setDataProvider_forTypes(ProtocolObject::from_ref(&*provider), &types) {
        return Err("the pasteboard refused the lazy data provider".into());
    }

    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let writable: Retained<ProtocolObject<dyn NSPasteboardWriting>> =
        ProtocolObject::from_retained(item);
    if pasteboard.writeObjects(&NSArray::from_slice(&[&*writable])) {
        Ok(pasteboard.changeCount())
    } else {
        Err("the pasteboard refused the promised item".into())
    }
}

pub fn still_ours(change_count: isize) -> bool {
    NSPasteboard::generalPasteboard().changeCount() == change_count
}
