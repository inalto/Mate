//! Raw request bodies on every platform.

use std::borrow::Cow;

use tauri::ipc::InvokeBody;

/// The bytes of a raw-body request. Android has no custom-protocol IPC (the webview cannot read
/// request bodies), so there a `Uint8Array` arrives as a JSON array of numbers. `None` for any
/// other body.
pub fn body_bytes(body: &InvokeBody) -> Option<Cow<'_, [u8]>> {
    match body {
        InvokeBody::Raw(bytes) => Some(Cow::Borrowed(bytes)),
        InvokeBody::Json(serde_json::Value::Array(items)) => items
            .iter()
            .map(|v| v.as_u64().and_then(|n| u8::try_from(n).ok()))
            .collect::<Option<Vec<u8>>>()
            .map(Cow::Owned),
        InvokeBody::Json(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_raw_and_json_byte_arrays() {
        let raw = InvokeBody::Raw(vec![1, 2, 255]);
        assert_eq!(body_bytes(&raw).as_deref(), Some(&[1u8, 2, 255][..]));
        let json = InvokeBody::Json(serde_json::json!([37, 80, 68, 70]));
        assert_eq!(body_bytes(&json).as_deref(), Some(&b"%PDF"[..]));
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!([1, 256]))).is_none());
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!([1, -1]))).is_none());
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!({"0": 1}))).is_none());
    }
}
