//! Protocol implementations and factory.

pub mod cap_driver;
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
    connection_details: &serde_json::Value,
) -> Result<Box<dyn EcrProtocol>, String> {
    match protocol {
        // CAP Driver is the vendor-supplied Windows file service used by
        // RBS/MAT fiscal cashiers. It is one installed adapter in the generic
        // ECR architecture, not a claim that all fiscal devices use CAP.
        "cap_driver" | "rbs_cap_driver" | "mat_cap_driver" => Ok(Box::new(
            cap_driver::CapDriverProtocol::new(transport, config, connection_details),
        )),
        // `generic` is retained as the persisted compatibility key. It is one
        // legacy Datecs-style command profile, not a universal fiscal adapter.
        "generic" | "escpos_fiscal" | "generic_escpos_fiscal" => Ok(Box::new(
            generic_fiscal::GenericEscPosFiscal::new(transport, config),
        )),
        "zvt" => Ok(Box::new(zvt::ZvtProtocol::new(transport, config))),
        "pax" => Ok(Box::new(pax::PaxProtocol::new(transport, config))),
        other => Err(format!(
            "Unsupported protocol: '{other}'. Installed adapters: CAP Driver, legacy Datecs-style STX/ETX (generic), ZVT, PAX. Install the exact vendor/model adapter before activation."
        )),
    }
}
