//! Prints a fresh 12-word BIP39 phrase: the regtest provider's throwaway Pubky identity.
fn main() {
    println!("{}", bip39::Mnemonic::generate(12).expect("12 words is a valid length"));
}
