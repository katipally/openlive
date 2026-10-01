//! The platform-neutral half of the OpenLive computer-use helper: the wire
//! protocol, NDJSON framing, token auth, the indexed accessibility-tree text,
//! screenshot geometry and the image size policy. Every OS backend implements
//! [`Backend`]; everything a model sees is shaped here, once, for all three.

pub mod auth;
pub mod backend;
pub mod framing;
pub mod geometry;
pub mod image;
pub mod keys;
pub mod protocol;
pub mod serve;
pub mod tree;

pub use backend::{Action, Backend, ClickAt, Observation, Resolved};
pub use protocol::{CuError, ErrorCode};
