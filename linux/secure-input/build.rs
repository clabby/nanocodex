fn main() {
    println!("cargo:rerun-if-changed=c/runner.c");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        cc::Build::new()
            .file("c/runner.c")
            .opt_level(2)
            .flag("-fstack-protector-strong")
            .flag("-D_FORTIFY_SOURCE=2")
            .warnings(true)
            .warnings_into_errors(true)
            .compile("nc_secure_sudo");
    }
}
