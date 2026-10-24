//! Wolfram|Alpha Short Answers API. The AppID is a secret: it is never logged and never put in
//! an error message (transport errors are stripped of their URL, which carries it).

use std::time::Duration;

pub const ENDPOINT: &str = "https://api.wolframalpha.com/v1/result";
const TIMEOUT: Duration = Duration::from_secs(20);

pub const NO_SHORT_ANSWER: &str = "Wolfram|Alpha has no short answer for this.";
pub const BAD_APPID: &str = "The AppID was not accepted. Check it in Settings.";
pub const OFF: &str = "Wolfram|Alpha is off. Turn it on in Settings.";

/// Ask `endpoint` (normally [`ENDPOINT`]) for the short answer to `query`, metric units.
pub fn short_answer(endpoint: &str, appid: &str, query: &str) -> Result<String, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("There is nothing to ask.".into());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "Could not start the request.".to_string())?;
    let res = client
        .get(endpoint)
        .query(&[("appid", appid), ("i", query), ("units", "metric")])
        .send()
        .map_err(|e| {
            if e.is_timeout() {
                "Wolfram|Alpha took too long to answer.".to_string()
            } else {
                "Could not reach Wolfram|Alpha. Check your connection.".to_string()
            }
        })?;
    match res.status().as_u16() {
        200 => {
            let text = res.text().map_err(|_| "Wolfram|Alpha sent an answer that could not be read.".to_string())?;
            let text = text.trim();
            if text.is_empty() { Err(NO_SHORT_ANSWER.into()) } else { Ok(text.to_string()) }
        }
        501 => Err(NO_SHORT_ANSWER.into()),
        400 => Err("Wolfram|Alpha could not understand this.".into()),
        401 | 403 => Err(BAD_APPID.into()),
        code => Err(format!("Wolfram|Alpha failed (error {code}). Try again later.")),
    }
}
