//! NDJSON framing: one JSON value per `\n`-terminated line.

use std::io::{self, BufRead, Read, Write};

/// The longest request line accepted. A paste of a long document fits; a
/// runaway writer does not get to grow the helper's memory without bound.
pub const MAX_LINE: usize = 4 * 1024 * 1024;

/// The next non-empty line without its terminator, or `None` at end of stream.
/// A line over `MAX_LINE` is an `InvalidData` error and the stream is no longer framed.
pub fn read_line(reader: &mut impl BufRead) -> io::Result<Option<String>> {
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let mut limited = (&mut *reader).take(MAX_LINE as u64 + 1);
        let n = limited.read_until(b'\n', &mut buf)?;
        if n == 0 {
            return Ok(None);
        }
        if buf.last() == Some(&b'\n') {
            buf.pop();
        } else if buf.len() > MAX_LINE {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "request line too long"));
        }
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
        if buf.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        return String::from_utf8(buf).map(Some).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e));
    }
}

/// Serialize `value` as one line and flush it, so a reply is never left in a buffer.
pub fn write_line(writer: &mut impl Write, value: &impl serde::Serialize) -> io::Result<()> {
    let mut line = serde_json::to_vec(value).map_err(io::Error::other)?;
    line.push(b'\n');
    writer.write_all(&line)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn reads_lines_and_skips_blank_ones() {
        let mut r = Cursor::new(b"{\"a\":1}\n\n  \r\n{\"b\":2}\r\n{\"c\":3}".to_vec());
        assert_eq!(read_line(&mut r).unwrap().as_deref(), Some("{\"a\":1}"));
        assert_eq!(read_line(&mut r).unwrap().as_deref(), Some("{\"b\":2}"));
        // A last line without a terminator still counts.
        assert_eq!(read_line(&mut r).unwrap().as_deref(), Some("{\"c\":3}"));
        assert_eq!(read_line(&mut r).unwrap(), None);
    }

    #[test]
    fn refuses_an_overlong_line() {
        let mut data = vec![b'x'; MAX_LINE + 10];
        data.push(b'\n');
        let err = read_line(&mut Cursor::new(data)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn a_line_exactly_at_the_cap_is_fine() {
        let mut data = vec![b'x'; MAX_LINE];
        data.push(b'\n');
        assert_eq!(read_line(&mut Cursor::new(data)).unwrap().unwrap().len(), MAX_LINE);
    }

    #[test]
    fn writes_one_flushed_line() {
        let mut out = Vec::new();
        write_line(&mut out, &serde_json::json!({"id": 1})).unwrap();
        assert_eq!(out, b"{\"id\":1}\n");
    }
}
