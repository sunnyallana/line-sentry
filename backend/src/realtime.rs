//! Real-time layer (Socket.IO via `socketioxide`).
//!
//! Parity note: the legacy Node server *broadcasts* every event with `io.emit`
//! and never targets the per-machine rooms it sets up — the dashboard and
//! department views rely on those global broadcasts. To keep the existing
//! frontend working through cutover we broadcast identically here, while still
//! honouring `join-machine`/`leave-machine` for protocol compatibility. Moving
//! to room-targeted emits is a coordinated backend+frontend change (Phase 4).

use serde::Serialize;
use socketioxide::extract::{Data, SocketRef};
use socketioxide::SocketIo;

/// Build the Socket.IO tower layer + handle. The layer mounts on `/socket.io/`.
pub fn build() -> (socketioxide::layer::SocketIoLayer, SocketIo) {
    let (layer, io) = SocketIo::new_layer();
    io.ns("/", on_connect);
    (layer, io)
}

fn on_connect(socket: SocketRef) {
    tracing::debug!("socket connected: {}", socket.id);

    socket.on(
        "join-machine",
        |socket: SocketRef, Data::<String>(machine_id)| {
            let _ = socket.join(format!("machine-{machine_id}"));
        },
    );

    socket.on(
        "leave-machine",
        |socket: SocketRef, Data::<String>(machine_id)| {
            let _ = socket.leave(format!("machine-{machine_id}"));
        },
    );

    socket.on_disconnect(|socket: SocketRef| {
        tracing::debug!("socket disconnected: {}", socket.id);
    });
}

/// Broadcast an event to every connected client (matches Node's `io.emit`).
pub async fn broadcast<T: Serialize + ?Sized>(io: &SocketIo, event: &'static str, data: &T) {
    if let Err(e) = io.emit(event, data).await {
        tracing::warn!("socket broadcast '{event}' failed: {e}");
    }
}
