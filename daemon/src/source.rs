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

    /// Read one digital byte (8 pins, LSB = DQ.0).
    pub fn read_byte(&mut self) -> anyhow::Result<u8> {
        match self {
            Source::Simulator(s) => Ok(s.read_byte()),
            #[cfg(feature = "plc")]
            Source::Plc(p) => p.read_byte(),
        }
    }
}

/// Generates realistic-looking signals: pins 4–7 act as "power" (held on) and
/// pins 0–3 as "unit-cycle" sensors that pulse intermittently — so whatever the
/// backend has mapped reacts. Lets the whole pipeline be exercised without a PLC.
pub struct Simulator {
    pulse_until: [Option<Instant>; 8],
}

impl Simulator {
    pub fn new() -> Self {
        Self { pulse_until: [None; 8] }
    }

    pub fn read_byte(&mut self) -> u8 {
        let now = Instant::now();
        let mut byte: u8 = 0;

        // Power pins (4–7): held on.
        for i in 4..8 {
            byte |= 1 << i;
        }

        // Unit-cycle pins (0–3): short pulses.
        for i in 0..4 {
            let active = match self.pulse_until[i] {
                Some(t) if now < t => true,
                _ => {
                    if rand::random::<f64>() < 0.30 {
                        self.pulse_until[i] = Some(now + Duration::from_millis(800));
                        true
                    } else {
                        self.pulse_until[i] = None;
                        false
                    }
                }
            };
            if active {
                byte |= 1 << i;
            }
        }
        byte
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

        /// Read process-outputs (PA) byte 0 — the same byte the Python daemon reads.
        pub fn read_byte(&mut self) -> anyhow::Result<u8> {
            let mut buf = [0u8; 1];
            match self
                .client
                .read_area(AreaTable::S7AreaPA, 0, 0, 1, WordLenTable::S7WLByte, &mut buf)
            {
                Ok(_) => Ok(buf[0]),
                Err(e) => {
                    tracing::warn!("PLC read failed ({e:?}); attempting reconnect");
                    self.reconnect()?;
                    Ok(0)
                }
            }
        }
    }
}
