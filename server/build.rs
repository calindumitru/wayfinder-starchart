// rust-embed needs the web app's export folder to exist at compile time; a fresh checkout has
// none until `npm run build` in web/, so create it empty and let the server say so at runtime.
fn main() {
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/out");
    std::fs::create_dir_all(&out).expect("create web/out");
    println!("cargo:rerun-if-changed=../web/out");
}
