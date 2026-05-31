//! Signal sources. The simulator is always available (and what we verify in CI);
//! the PLC reader is compiled only with `--features plc` on a host that has
//! libsnap7, and reads the same byte the Python `signal_recorder.py` does.

use std::time::{Duration, Instant};

use crate::config::{Config, SourceKind};

pub enum Source {
    Simulator(Simulator),
    #[cfg(feature = "plc")]
    Plc(plc::PlcReader),
}

impl Source {
    pub fn from_config(cfg: &Config) -> anyhow::Result<Self> {
        match cfg.source {
            SourceKind::Simulator => Ok(Source::Simulator(Simulator::new())),
            #[cfg(feature = "plc")]
            SourceKind::Plc => Ok(Source::Plc(plc::PlcReader::connect(&cfg.plc)?)),
            #[cfg(not(feature = "plc"))]
            SourceKind::Plc => anyhow::bail!(
                "config requests the PLC source but the daemon was built without the `plc` feature; \
                 rebuild with `cargo build --release --features plc` on a host with libsnap7"
            ),
        }
    }

    /// Read `count` output bytes (8 pins per byte, LSB = bit 0 of byte 0).
    pub fn read(&mut self, count: usize) -> anyhow::Result<Vec<u8>> {
        match self {
            Source::Simulator(s) => Ok(s.read(count)),
            #[cfg(feature = "plc")]
            Source::Plc(p) => p.read(count),
        }
    }
}

/// Generates realistic-looking signals across as many bytes as requested: in
/// each byte, bits 4–7 act as "power" (held on) and bits 0–3 as "unit-cycle"
/// sensors that pulse intermittently — so whatever the backend has mapped (on
/// any pin) reacts. Lets the whole pipeline be exercised without a PLC.
pub struct Simulator {
    pulse_until: Vec<Option<Instant>>,
}

impl Simulator {
    pub fn new() -> Self {
        Self {
            pulse_until: Vec::new(),
        }
    }

    pub fn read(&mut self, count: usize) -> Vec<u8> {
        let now = Instant::now();
        if self.pulse_until.len() < count * 8 {
            self.pulse_until.resize(count * 8, None);
        }
        let mut bytes = vec![0u8; count];
        for (b, byte) in bytes.iter_mut().enumerate() {
            // Power pins (bits 4–7): held on.
            for i in 4..8 {
                *byte |= 1 << i;
            }
            // Unit-cycle pins (bits 0–3): short pulses.
            for i in 0..4 {
                let idx = b * 8 + i;
                let active = match self.pulse_until[idx] {
                    Some(t) if now < t => true,
                    _ => {
                        if rand::random::<f64>() < 0.30 {
                            self.pulse_until[idx] = Some(now + Duration::from_millis(800));
                            true
                        } else {
                            self.pulse_until[idx] = None;
                            false
                        }
                    }
                };
                if active {
                    *byte |= 1 << i;
                }
            }
        }
        bytes
    }
}

#[cfg(feature = "plc")]
mod plc {
    use crate::config::PlcConfig;
    use snap7_rs::{AreaTable, S7Client, WordLenTable};

    pub struct PlcReader {
        client: S7Client,
        ip: String,
        rack: i32,
        slot: i32,
    }

    impl PlcReader {
        pub fn connect(cfg: &PlcConfig) -> anyhow::Result<Self> {
            let reader = Self {
                client: S7Client::create(),
                ip: cfg.ip.clone(),
                rack: cfg.rack,
                slot: cfg.slot,
            };
            reader.reconnect()?;
            Ok(reader)
        }

        fn reconnect(&self) -> anyhow::Result<()> {
            tracing::info!(ip = %self.ip, rack = self.rack, slot = self.slot, "connecting to PLC");
            self.client
                .connect_to(&self.ip, self.rack, self.slot)
                .map_err(|e| anyhow::anyhow!("PLC connect failed: {e:?}"))?;
            Ok(())
        }

        /// Read `count` process-output (PA) bytes starting at byte 0 — the same
        /// area the Python daemon reads, widened to support more pins.
        pub fn read(&mut self, count: usize) -> anyhow::Result<Vec<u8>> {
            let mut buf = vec![0u8; count.max(1)];
            match self.client.read_area(
                AreaTable::S7AreaPA,
                0,
                0,
                buf.len() as i32,
                WordLenTable::S7WLByte,
                &mut buf,
            ) {
                Ok(_) => Ok(buf),
                Err(e) => {
                    tracing::warn!("PLC read failed ({e:?}); attempting reconnect");
                    self.reconnect()?;
                    Ok(vec![0u8; count.max(1)])
                }
            }
        }
    }
}
