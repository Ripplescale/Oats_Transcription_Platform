//! Append-only delivery of cumulative, confirmed dictation text. The worker
//! finalizes speech phrases before publication. No provisional hypotheses,
//! alignment guesses, or edits to already-delivered text are accepted here.

const MAX_INSERT_UTF16: usize = 32_768;

/// Match the Windows Unicode sender before comparing cumulative prefixes.
pub(super) fn normalize_text(text: &str) -> Result<String, String> {
    let mut normalized = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '\r' | '\n' | '\t' => normalized.push(' '),
            value if value.is_control() => return Err(
                "Dictation contains a control character and was not typed. Use Copy to review the text.".into()),
            value => normalized.push(value),
        }
    }
    if normalized.encode_utf16().count() > MAX_INSERT_UTF16 {
        return Err("This dictation is too long for automatic typing. Your text is available to copy.".into());
    }
    Ok(normalized)
}

#[derive(Default)]
pub(super) struct Delivery {
    // Exact normalized text accepted by the callback. Partial input failures
    // are unknown and never advance this ledger or permit a retry.
    committed: String,
    blocked: Option<String>,
    final_text: Option<String>,
    finished: bool,
}

impl Delivery {
    pub(super) fn new() -> Self { Self::default() }
    pub(super) fn committed(&self) -> &str { &self.committed }
    pub(super) fn inserted_characters(&self) -> usize { self.committed.chars().count() }
    pub(super) fn blocked_reason(&self) -> Option<&str> { self.blocked.as_deref() }
    pub(super) fn final_text(&self) -> Option<&str> { self.final_text.as_deref() }

    /// Interruption ends automatic delivery for this session. A later final
    /// result is still retained in full for explicit Copy.
    pub(super) fn interrupt(&mut self, reason: String) {
        if self.blocked.is_none() { self.blocked = Some(reason); }
    }

    /// Supply confirmed cumulative text from the same session in request order.
    /// Each new suffix is attempted exactly once, immediately. Stop supplies the
    /// same phrase assembly with its remaining tail appended. OS focus/input
    /// guards belong to the insertion callback. Revisions behind the delivered
    /// boundary always stop delivery; no case/punctuation exceptions apply.
    pub(super) fn observe(
        &mut self,
        confirmed: &str,
        final_request: bool,
        mut insert: impl FnMut(&str) -> Result<(), String>,
    ) {
        if self.finished { return; }
        if final_request {
            self.final_text = Some(confirmed.to_owned());
            self.finished = true;
        }
        if self.blocked.is_some() { return; }
        let text = match normalize_text(confirmed) {
            Ok(text) => text,
            Err(error) => { self.interrupt(error); return; }
        };
        let Some(suffix) = text.strip_prefix(&self.committed) else {
            self.interrupt("Confirmed dictation changed words that were already typed. Automatic typing stopped; the full result is available to copy.".into());
            return;
        };
        if suffix.trim().is_empty() { return; }
        match insert(suffix) {
            Ok(()) => self.committed.push_str(suffix),
            Err(error) => self.interrupt(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observe(delivery: &mut Delivery, text: &str, final_request: bool, sent: &mut Vec<String>) {
        delivery.observe(text, final_request, |suffix| { sent.push(suffix.to_owned()); Ok(()) });
    }

    #[test]
    fn confirmed_phrases_arrive_immediately_and_final_flushes_only_the_tail() {
        let mut delivery = Delivery::new(); let mut sent = Vec::new();
        observe(&mut delivery, "First complete phrase.", false, &mut sent);
        assert_eq!(sent, ["First complete phrase."]);
        observe(&mut delivery, "First complete phrase. अगला वाक्य।", false, &mut sent);
        assert_eq!(sent, ["First complete phrase.", " अगला वाक्य।"]);
        observe(&mut delivery, "First complete phrase. अगला वाक्य। Last words", true, &mut sent);
        assert_eq!(sent, ["First complete phrase.", " अगला वाक्य।", " Last words"]);
        assert_eq!(delivery.committed(), "First complete phrase. अगला वाक्य। Last words");
        assert_eq!(delivery.final_text(), Some("First complete phrase. अगला वाक्य। Last words"));
    }

    #[test]
    fn duplicate_results_and_final_callbacks_never_repeat_input() {
        let mut delivery = Delivery::new(); let mut sent = Vec::new();
        for _ in 0..4 { observe(&mut delivery, "hello world", false, &mut sent); }
        for _ in 0..3 { observe(&mut delivery, "hello world", true, &mut sent); }
        observe(&mut delivery, "late callback", false, &mut sent);
        assert_eq!(sent, ["hello world"]);
        assert_eq!(delivery.final_text(), Some("hello world"));
    }

    #[test]
    fn short_dictation_can_arrive_only_at_stop() {
        let mut delivery = Delivery::new(); let mut sent = Vec::new();
        observe(&mut delivery, "", false, &mut sent);
        observe(&mut delivery, "A short phrase", true, &mut sent);
        assert_eq!(sent, ["A short phrase"]);
        assert_eq!(delivery.final_text(), Some("A short phrase"));
    }

    #[test]
    fn any_prefix_revision_blocks_without_alignment_or_rewriting() {
        for revised in ["Hello world again", "hello, world again", "hello word again",
            "new hello world again", "hello", "world hello again", ""] {
            let mut delivery = Delivery::new(); let mut sent = Vec::new();
            observe(&mut delivery, "hello world", false, &mut sent);
            observe(&mut delivery, revised, false, &mut sent);
            assert!(delivery.blocked_reason().is_some(), "{revised}");
            observe(&mut delivery, "hello world again", true, &mut sent);
            assert_eq!(sent, ["hello world"]);
            assert_eq!(delivery.final_text(), Some("hello world again"));
        }
    }

    #[test]
    fn final_revision_retains_the_whole_result_for_copy() {
        let mut delivery = Delivery::new(); let mut sent = Vec::new();
        observe(&mut delivery, "earlier phrase", false, &mut sent);
        observe(&mut delivery, "corrected phrase and final words", true, &mut sent);
        assert_eq!(sent, ["earlier phrase"]);
        assert_eq!(delivery.committed(), "earlier phrase");
        assert_eq!(delivery.final_text(), Some("corrected phrase and final words"));
        assert!(delivery.blocked_reason().is_some());
    }

    #[test]
    fn partial_input_failure_never_retries_or_claims_unknown_characters() {
        let mut delivery = Delivery::new(); let mut attempts = 0;
        delivery.observe("first", false, |_| Ok(()));
        delivery.observe("first second", false, |_| {
            attempts += 1; Err("Some text may already be present".into())
        });
        delivery.observe("first second final", true, |_| { attempts += 1; Ok(()) });
        assert_eq!(attempts, 1);
        assert_eq!(delivery.committed(), "first");
        assert_eq!(delivery.inserted_characters(), 5);
        assert_eq!(delivery.final_text(), Some("first second final"));
    }

    #[test]
    fn cancellation_and_user_input_keep_sent_text_and_stop_future_insertion() {
        for reason in ["Dictation cancelled", "The user moved the caret"] {
            let mut delivery = Delivery::new(); let mut sent = Vec::new();
            observe(&mut delivery, "already typed", false, &mut sent);
            delivery.interrupt(reason.into());
            delivery.interrupt("Later error".into());
            observe(&mut delivery, "already typed another phrase", false, &mut sent);
            observe(&mut delivery, "already typed another phrase final", true, &mut sent);
            assert_eq!(sent, ["already typed"]);
            assert_eq!(delivery.blocked_reason(), Some(reason));
            assert_eq!(delivery.final_text(), Some("already typed another phrase final"));
        }
    }

    #[test]
    fn copy_only_session_never_inserts_but_keeps_final_text() {
        let mut delivery = Delivery::new();
        delivery.interrupt("Copy only".into());
        delivery.observe("first phrase", false, |_| panic!("copy-only insertion"));
        delivery.observe("first phrase final words", true, |_| panic!("copy-only insertion"));
        assert_eq!(delivery.inserted_characters(), 0);
        assert_eq!(delivery.final_text(), Some("first phrase final words"));
    }

    #[test]
    fn unicode_and_sender_normalization_preserve_cumulative_boundaries() {
        let mut delivery = Delivery::new(); let mut sent = Vec::new();
        observe(&mut delivery, "हिन्दी\t🥣", false, &mut sent);
        observe(&mut delivery, "हिन्दी 🥣\nwords", true, &mut sent);
        assert_eq!(sent, ["हिन्दी 🥣", " words"]);
        assert_eq!(delivery.committed(), "हिन्दी 🥣 words");
        assert_eq!(delivery.inserted_characters(), "हिन्दी 🥣 words".chars().count());
        assert_eq!(delivery.final_text(), Some("हिन्दी 🥣\nwords"));
    }

    #[test]
    fn empty_updates_do_not_type_and_deferred_whitespace_is_not_lost() {
        let mut delivery = Delivery::new(); let mut sent = Vec::new();
        observe(&mut delivery, "", false, &mut sent);
        observe(&mut delivery, "hello", false, &mut sent);
        observe(&mut delivery, "hello ", false, &mut sent);
        assert_eq!(sent, ["hello"]);
        observe(&mut delivery, "hello world", true, &mut sent);
        assert_eq!(sent, ["hello", " world"]);
        let mut silent = Delivery::new();
        silent.observe(" \t\n", true, |_| panic!("empty insertion"));
        assert_eq!(silent.inserted_characters(), 0);
        assert_eq!(silent.final_text(), Some(" \t\n"));
    }

    #[test]
    fn controls_and_utf16_limits_block_before_input_and_keep_final_result() {
        for text in ["unsafe\u{1b}".to_owned(), "x".repeat(MAX_INSERT_UTF16 + 1),
            "🥣".repeat(MAX_INSERT_UTF16 / 2 + 1)] {
            let mut delivery = Delivery::new();
            delivery.observe(&text, true, |_| panic!("invalid input"));
            assert!(delivery.blocked_reason().is_some());
            assert_eq!(delivery.inserted_characters(), 0);
            assert_eq!(delivery.final_text(), Some(text.as_str()));
        }
        let mut boundary = Delivery::new();
        let maximum = "🥣".repeat(MAX_INSERT_UTF16 / 2);
        boundary.observe(&maximum, true, |_| Ok(()));
        assert_eq!(boundary.committed(), maximum);
        assert!(boundary.blocked_reason().is_none());
    }

    #[test]
    fn a_new_session_does_not_reuse_old_delivery_state() {
        let mut old = Delivery::new();
        old.observe("old text", true, |_| Ok(()));
        let mut next = Delivery::new(); let mut sent = Vec::new();
        observe(&mut next, "new text", false, &mut sent);
        assert_eq!(sent, ["new text"]);
        assert_eq!(old.final_text(), Some("old text"));
    }
}
