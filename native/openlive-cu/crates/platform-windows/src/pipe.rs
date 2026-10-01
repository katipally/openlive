//! The helper's named pipe, readable and writable by this user alone.
//!
//! A named pipe's default security descriptor grants Everyone read access, and
//! unlike the Unix socket it does not sit inside the client's private
//! directory, so any process could open it and try tokens. A protected DACL
//! with one entry, generic all for the user running the helper, shuts everyone
//! else out before the token is ever checked.

/// SDDL owning the pipe by `sid` and granting it, and nobody else, full access.
/// `None` for anything that is not a SID string, so nothing else lands in the descriptor.
pub fn sddl(sid: &str) -> Option<String> {
    let well_formed = sid.strip_prefix("S-1-").is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit() || c == '-'));
    well_formed.then(|| format!("O:{sid}D:P(A;;GA;;;{sid})"))
}

/// The SID string of the user this process runs as.
#[cfg(windows)]
pub fn current_user_sid() -> std::io::Result<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let err = |e: windows::core::Error| std::io::Error::other(e.message());
    // SAFETY: plain token queries into buffers sized by the first call; every handle and allocation is released.
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(err)?;
        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
        let mut buf = vec![0u8; len as usize];
        let read = GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr().cast()), len, &mut len);
        let _ = CloseHandle(token);
        read.map_err(err)?;
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text).map_err(err)?;
        let sid = text.to_string().map_err(std::io::Error::other);
        let _ = LocalFree(Some(HLOCAL(text.0.cast())));
        sid
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grants_the_one_user_and_nobody_else() {
        let sid = "S-1-5-21-3623811015-3361044348-30300820-1013";
        assert_eq!(sddl(sid).unwrap(), format!("O:{sid}D:P(A;;GA;;;{sid})"));
    }

    #[test]
    fn refuses_anything_that_is_not_a_sid() {
        assert_eq!(sddl(""), None);
        assert_eq!(sddl("S-1-"), None);
        assert_eq!(sddl("WD"), None);
        assert_eq!(sddl("S-1-5)(A;;GA;;;WD"), None);
    }
}
