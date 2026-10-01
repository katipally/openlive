//! Embeds the Windows manifest (asInvoker, per-monitor DPI awareness) in the
//! helper. The MSVC linker takes it directly; other Windows toolchains go
//! without, and the backend sets DPI awareness at startup instead.

fn main() {
    println!("cargo:rerun-if-changed=openlive-cu.exe.manifest");
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if windows && msvc {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("openlive-cu.exe.manifest");
        println!("cargo:rustc-link-arg-bins=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-bins=/MANIFESTINPUT:{}", manifest.display());
    }
}
