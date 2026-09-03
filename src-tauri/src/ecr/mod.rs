//! ECR (Electronic Cash Register) module.
//!
//! Provides a trait-based protocol framework for communicating with fiscal cash
//! registers and payment terminals. Transport support (serial, network, or
//! Bluetooth) does not imply wire-protocol compatibility. Each vendor/model
//! must use a separately verified protocol adapter.

pub mod codepage;
pub mod device_manager;
pub mod fiscal;
pub mod protocol;
pub mod protocols;
pub mod transport;

pub use device_manager::DeviceManager;
