//! ECR (Electronic Cash Register) module.
//!
//! Provides a trait-based protocol framework for communicating with fiscal cash
//! registers and payment terminals across Europe and the Balkans. Supports
//! multiple connection types (serial, network, Bluetooth) and protocols
//! (Generic ESC/POS Fiscal, ZVT, PAX).

pub mod device_manager;
pub mod fiscal;
pub mod protocol;
pub mod protocols;
pub mod transport;

pub use device_manager::DeviceManager;
