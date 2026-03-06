/// RustSSH QR pairing helpers.
///
/// A pairing string is a URL-like tag:
///   russh://relay=<addr>&id=<host_id>&fp=<relay_fingerprint_hex>
///
/// The host daemon prints this as a QR code in the terminal.
/// The client decodes it from stdin (paste the string) or directly accepts the raw string.

pub const SCHEME: &str = "russh://";

/// Encode connection params into a pairing string.
pub fn encode(relay: &str, host_id: &str, relay_fp: &str) -> String {
    format!("{}relay={}&id={}&fp={}", SCHEME, relay, host_id, relay_fp)
}

/// Decode a pairing string. Returns (relay_addr, host_id, relay_fp).
pub fn decode(s: &str) -> Option<(String, String, String)> {
    let s = s.trim();
    let body = s.strip_prefix(SCHEME)?;
    let mut relay = String::new();
    let mut id = String::new();
    let mut fp = String::new();

    for part in body.split('&') {
        if let Some(v) = part.strip_prefix("relay=") { relay = v.to_string(); }
        else if let Some(v) = part.strip_prefix("id=")    { id    = v.to_string(); }
        else if let Some(v) = part.strip_prefix("fp=")    { fp    = v.to_string(); }
    }

    if relay.is_empty() || id.is_empty() { None } else { Some((relay, id, fp)) }
}

/// Print a QR code to the terminal (Unicode block chars, works in any terminal).
pub fn print_qr(data: &str) {
    use qrcode::{QrCode, render::unicode};
    match QrCode::new(data.as_bytes()) {
        Ok(code) => {
            let img = code.render::<unicode::Dense1x2>()
                .dark_color(unicode::Dense1x2::Dark)
                .light_color(unicode::Dense1x2::Light)
                .build();
            println!("{}", img);
        }
        Err(e) => eprintln!("QR generation failed: {}", e),
    }
}
