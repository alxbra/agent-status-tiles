use std::io;

fn main() {
    // Hook processes must never interfere with the harness. Every invalid input
    // and filesystem error is deliberately a successful no-op.
    let _ = hook_helper::run(std::env::args().skip(1), io::stdin());
}
