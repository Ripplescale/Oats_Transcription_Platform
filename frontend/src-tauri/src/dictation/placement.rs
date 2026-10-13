//! Popup geometry and preference storage; no audio, focus, or input delivery.
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path};

pub const WIDTH: f64 = 264.0;
pub const COLLAPSED_HEIGHT: f64 = 48.0;
pub const EXPANDED_HEIGHT: f64 = 220.0;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub origin: Point,
    pub width: i32,
    pub height: i32,
}
#[derive(Clone, Copy)]
pub struct Work {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Preference {
    version: u8,
    anchor: Point,
}

fn valid_point(point: Point) -> bool {
    point.x.abs_diff(0) <= 1_000_000 && point.y.abs_diff(0) <= 1_000_000
}
pub fn load(path: &Path) -> Result<Option<Point>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Popup preferences must be an ordinary file.".into());
        }
    }
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 1024 {
        return Err("Popup preferences are invalid.".into());
    }
    let value: Preference = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "Popup preferences are invalid.")?;
    if value.version != 1 || !valid_point(value.anchor) {
        return Err("Popup preferences are invalid.".into());
    }
    Ok(Some(value.anchor))
}
pub fn save(path: &Path, point: Point) -> Result<(), String> {
    if !valid_point(point) {
        return Err("Popup position is outside the supported desktop.".into());
    }
    let parent = path
        .parent()
        .ok_or("Popup preferences have no directory.")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create popup preferences.")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "Could not save popup position.")?;
    let bytes = serde_json::to_vec(&Preference {
        version: 1,
        anchor: point,
    })
    .map_err(|e| e.to_string())?;
    temporary
        .write_all(&bytes)
        .map_err(|_| "Could not save popup position.")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "Could not save popup position.")?;
    temporary
        .persist(path)
        .map_err(|_| "Could not save popup position.")?;
    Ok(())
}

pub fn fit(anchor: Option<Point>, work: Work, scale: f64, expanded: bool) -> Result<Rect, String> {
    let available_width = i64::from(work.right) - i64::from(work.left);
    let available_height = i64::from(work.bottom) - i64::from(work.top);
    if available_width <= 0
        || available_height <= 0
        || !scale.is_finite()
        || !(0.25..=8.0).contains(&scale)
    {
        return Err("The popup display has invalid dimensions or scale.".into());
    }
    let width = ((WIDTH * scale).round() as i64).min(available_width);
    let height = (((if expanded {
        EXPANDED_HEIGHT
    } else {
        COLLAPSED_HEIGHT
    }) * scale)
        .round() as i64)
        .min(available_height);
    let default = Point {
        x: (i64::from(work.left) + (available_width - width) / 2) as i32,
        y: (i64::from(work.bottom) - height - (24.0 * scale).round() as i64)
            .max(i64::from(work.top)) as i32,
    };
    let requested = anchor.unwrap_or(default);
    Ok(Rect {
        origin: Point {
            x: i64::from(requested.x).clamp(i64::from(work.left), i64::from(work.right) - width)
                as i32,
            y: i64::from(requested.y).clamp(i64::from(work.top), i64::from(work.bottom) - height)
                as i32,
        },
        width: width as i32,
        height: height as i32,
    })
}

#[derive(Clone, Copy)]
struct Drag {
    origin: Point,
    cursor: Point,
}
#[derive(Default)]
pub struct State {
    pub anchor: Option<Point>,
    pub rect: Option<Rect>,
    pub session: Option<String>,
    pub expanded: bool,
    drag: Option<Drag>,
}
impl State {
    pub fn new(anchor: Option<Point>) -> Self {
        Self {
            anchor,
            ..Self::default()
        }
    }
    pub fn session(&mut self, session: &Option<String>) {
        if self.session != *session {
            self.session = session.clone();
            self.expanded = false;
            self.drag = None;
        }
    }
    pub fn place(&mut self, work: Work, scale: f64, forced_expanded: bool) -> Result<Rect, String> {
        let rect = fit(self.anchor, work, scale, self.expanded || forced_expanded)?;
        // Remember the initial default once. Phase changes must not follow the
        // foreground window or overwrite a preferred near-edge anchor.
        if self.anchor.is_none() {
            self.anchor = Some(rect.origin);
        }
        self.rect = Some(rect);
        Ok(rect)
    }
    pub fn begin(&mut self, cursor: Point) -> Result<(), String> {
        if self.drag.is_some() {
            return Err("A popup drag is already active.".into());
        }
        let rect = self.rect.ok_or("The popup has not opened yet.")?;
        if i64::from(cursor.x) < i64::from(rect.origin.x)
            || i64::from(cursor.x) >= i64::from(rect.origin.x) + i64::from(rect.width)
            || i64::from(cursor.y) < i64::from(rect.origin.y)
            || i64::from(cursor.y) >= i64::from(rect.origin.y) + i64::from(rect.height)
        {
            return Err("Drag the popup using its grip.".into());
        }
        self.drag = Some(Drag {
            origin: rect.origin,
            cursor,
        });
        Ok(())
    }
    pub fn move_to(&mut self, cursor: Point) -> Result<(), String> {
        let drag = self.drag.ok_or("Start a popup drag first.")?;
        let x = i64::from(drag.origin.x) + i64::from(cursor.x) - i64::from(drag.cursor.x);
        let y = i64::from(drag.origin.y) + i64::from(cursor.y) - i64::from(drag.cursor.y);
        if !(-1_000_000..=1_000_000).contains(&x) || !(-1_000_000..=1_000_000).contains(&y) {
            return Err("Popup movement is outside the supported desktop.".into());
        }
        self.anchor = Some(Point {
            x: x as i32,
            y: y as i32,
        });
        Ok(())
    }
    pub fn end(&mut self) -> Result<Point, String> {
        if self.drag.take().is_none() {
            return Err("Start a popup drag first.".into());
        }
        let point = self.rect.ok_or("The popup has not opened yet.")?.origin;
        self.anchor = Some(point);
        Ok(point)
    }
    pub fn cancel(&mut self) {
        self.drag = None;
        if let Some(rect) = self.rect {
            self.anchor = Some(rect.origin);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn desktop() -> Work {
        Work {
            left: -1920,
            top: -200,
            right: 0,
            bottom: 840,
        }
    }
    #[test]
    fn negative_monitor_and_dpi_fit_full_rectangle() {
        let rect = fit(Some(Point { x: -100, y: 800 }), desktop(), 1.5, true).unwrap();
        assert_eq!(
            rect,
            Rect {
                origin: Point { x: -396, y: 510 },
                width: 396,
                height: 330
            }
        );
    }
    #[test]
    fn removed_monitor_anchor_is_clamped_to_replacement_work_area() {
        let work = Work {
            left: 0,
            top: 40,
            right: 1280,
            bottom: 720,
        };
        let rect = fit(Some(Point { x: -1900, y: -100 }), work, 2.0, true).unwrap();
        assert_eq!(rect.origin, Point { x: 0, y: 40 });
        assert_eq!(rect.width, 528);
    }
    #[test]
    fn expansion_and_session_changes_preserve_preferred_anchor() {
        let mut state = State::new(Some(Point { x: -600, y: 750 }));
        let collapsed = state.place(desktop(), 1.0, false).unwrap();
        assert_eq!(state.place(desktop(), 1.0, true).unwrap().origin.y, 620);
        assert_eq!(state.place(desktop(), 1.0, false).unwrap(), collapsed);
        state.session(&Some("next".into()));
        assert_eq!(state.place(desktop(), 1.0, false).unwrap(), collapsed);
    }
    #[test]
    fn dragging_uses_cumulative_physical_cursor_and_new_sessions_reject_old_moves() {
        let mut state = State::new(Some(Point { x: -600, y: 500 }));
        state.session(&Some("one".into()));
        state.place(desktop(), 1.5, false).unwrap();
        state.begin(Point { x: -590, y: 510 }).unwrap();
        state.move_to(Point { x: -490, y: 410 }).unwrap();
        state.place(desktop(), 1.0, false).unwrap();
        state.move_to(Point { x: -390, y: 310 }).unwrap();
        state.place(desktop(), 2.0, false).unwrap();
        assert_eq!(state.anchor, Some(Point { x: -400, y: 300 }));
        assert_eq!(state.end().unwrap(), Point { x: -528, y: 300 });
        state.begin(Point { x: -520, y: 310 }).unwrap();
        state.session(&Some("two".into()));
        assert!(state.move_to(Point { x: 0, y: 0 }).is_err());
        assert!(state.end().is_err());
    }
    #[test]
    fn preference_round_trip_replaces_only_position_and_rejects_malformed_data() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("preferences.json");
        assert_eq!(load(&file).unwrap(), None);
        save(&file, Point { x: -10, y: 40 }).unwrap();
        save(&file, Point { x: 25, y: -70 }).unwrap();
        assert_eq!(load(&file).unwrap(), Some(Point { x: 25, y: -70 }));
        fs::write(&file, br#"{"version":2,"anchor":{"x":0,"y":0}}"#).unwrap();
        assert!(load(&file).is_err());
        fs::write(&file, vec![b'x'; 1025]).unwrap();
        assert!(load(&file).is_err());
    }
    #[test]
    fn invalid_geometry_and_non_gesture_moves_are_rejected() {
        assert!(fit(None, desktop(), f64::NAN, false).is_err());
        assert!(fit(
            None,
            Work {
                left: 0,
                top: 0,
                right: 0,
                bottom: 10
            },
            1.0,
            false
        )
        .is_err());
        let mut state = State::default();
        assert!(state.move_to(Point { x: 1, y: 2 }).is_err());
        state.place(desktop(), 1.0, false).unwrap();
        assert!(state.begin(Point { x: 10000, y: 10000 }).is_err());
    }
}
