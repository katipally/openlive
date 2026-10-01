//! Token auth. The client writes a random token to a 0600 file in a private
//! directory, passes the path, and sends the token with every request. The
//! socket lives in that same directory, so the token is the second lock, for
//! any process that can reach the socket anyway (a Windows pipe, say).

use std::path::Path;

/// Shorter than this is not a secret worth checking.
pub const MIN_TOKEN_LEN: usize = 16;

/// Read and trim the token file, then delete it: once in memory it has no reason to sit on disk.
pub fn take_token(path: &Path) -> std::io::Result<String> {
    let token = std::fs::read_to_string(path)?.trim().to_owned();
    let _ = std::fs::remove_file(path);
    if token.len() < MIN_TOKEN_LEN {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "token too short"));
    }
    Ok(token)
}

/// Constant-time in the length of `expected`, so timing does not leak a prefix.
pub fn token_matches(expected: &str, given: &str) -> bool {
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    let mut diff = a.len() ^ b.len();
    for (i, x) in a.iter().enumerate() {
        diff |= usize::from(x ^ b.get(i).copied().unwrap_or(0));
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_the_exact_token() {
        let t = "0123456789abcdef0123";
        assert!(token_matches(t, t));
        assert!(!token_matches(t, ""));
        assert!(!token_matches(t, "0123456789abcdef012"));
        assert!(!token_matches(t, "0123456789abcdef01234"));
        assert!(!token_matches(t, "x123456789abcdef0123"));
    }

    #[test]
    fn takes_the_token_once() {
        let dir = std::env::temp_dir().join(format!("olcu-auth-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("token");
        std::fs::write(&file, "  abcdefghijklmnopqrstuvwxyz\n").unwrap();
        assert_eq!(take_token(&file).unwrap(), "abcdefghijklmnopqrstuvwxyz");
        assert!(!file.exists());
        std::fs::write(&file, "short").unwrap();
        assert!(take_token(&file).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
