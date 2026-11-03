use std::time::Instant;

#[derive(Default)]
pub struct ServerClock {
    anchor: Option<(String, i64, Instant)>,
}

pub fn parse(value: &str) -> Result<i64, &'static str> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|v| v.timestamp_millis())
        .map_err(|_| "INVALID_INPUT")
}

pub fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .expect("bounded server timestamp")
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl ServerClock {
    pub fn observe(
        &mut self,
        session: &str,
        server_time: &str,
        at: Instant,
    ) -> Result<(), &'static str> {
        let ms = parse(server_time)?;
        let ms = self.now_at(session, at).map_or(ms, |old| old.max(ms));
        self.anchor = Some((session.into(), ms, at));
        Ok(())
    }
    pub fn now_at(&self, session: &str, at: Instant) -> Option<i64> {
        let (id, ms, instant) = self.anchor.as_ref()?;
        if id != session {
            return None;
        }
        ms.checked_add(
            at.checked_duration_since(*instant)?
                .as_millis()
                .try_into()
                .ok()?,
        )
    }
    pub fn now(&self, session: &str) -> Option<i64> {
        self.now_at(session, Instant::now())
    }
    pub fn clear(&mut self) {
        self.anchor = None;
    }
}
