use napi_derive::napi;
use tokenizers::Tokenizer;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::RwLock;

static TOKENIZER_CACHE: Lazy<RwLock<HashMap<String, Tokenizer>>> = Lazy::new(|| {
    RwLock::new(HashMap::new())
});

#[napi]
pub fn count_tokens(text: String, model_type: String) -> i32 {
    let text_len = text.len();
    let cache = TOKENIZER_CACHE.read().unwrap();

    if let Some(tokenizer) = cache.get(&model_type) {
        if let Ok(encoding) = tokenizer.encode(text, true) {
            return encoding.get_ids().len() as i32;
        }
    }

    // Fallback: roughly 4 chars per token if tokenizer isn't loaded/fails
    (text_len as f32 / 4.0).ceil() as i32
}

#[napi]
pub fn load_tokenizer(model_type: String, json_data: String) -> bool {
    match Tokenizer::from_str(&json_data) {
        Ok(tokenizer) => {
            let mut cache = TOKENIZER_CACHE.write().unwrap();
            cache.insert(model_type, tokenizer);
            true
        }
        Err(_) => false,
    }
}
