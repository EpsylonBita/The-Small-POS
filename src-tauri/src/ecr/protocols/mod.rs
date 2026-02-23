//! Protocol implementations and factory.

pub mod generic_fiscal;
pub mod pax;
pub mod zvt;

use super::protocol::EcrProtocol;
use super::transport::EcrTransport;

/// Create the appropriate protocol adapter for a given protocol name.
///
/// The transport must already be constructed (but not necessarily connected).
pub fn create_protocol(
    protocol: &str,
    transport: Box<dyn EcrTransport>,
    config: &serde_json::Value,
) -> Result<Box<dyn EcrProtocol>, String> {
    match protocol {
        "generic" | "escpos_fiscal" | "generic_escpos_fiscal" => Ok(Box::new(
            generic_fiscal::GenericEscPosFiscal::new(transport, config),
        )),
        "zvt" => Ok(Box::new(zvt::ZvtProtocol::new(transport, config))),
        "pax" => Ok(Box::new(pax::PaxProtocol::new(transport, config))),
        other => Err(format!(
            "Unsupported protocol: '{other}'. Supported: generic, zvt, pax"
        )),
    }
}
