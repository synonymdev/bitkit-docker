//! VSS JWT Authentication Integration Test Binary
//! 
//! Tests JWT validation by making actual HTTP requests to the VSS server

use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use prost::Message;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::SystemTime;
use std::fs;
use vss_client::types::ListKeyVersionsRequest;

#[derive(Deserialize, Serialize)]
struct TestClaims {
    sub: String,
    iat: i64,
    nbf: i64,
    exp: i64,
}

const VSS_URL: &str = "http://localhost:23050";

// Path to private key used by lnurl-server for JWT
const VALID_PRIVATE_KEY_PATH: &str = "../lnurl-server/keys/private.pem";

const INVALID_PRIVATE_KEY: &str = "-----BEGIN PRIVATE KEY-----\
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQC77KWE/VUi7QTc\
odlj5yRaawPO4z+Ik4c2r2W1BaivIn2dkeTYKT9cQUEcU3sP/i4bQ/DnSuOWAmmG\
yaR4NvUvJyGxm6PSBf/kgzDbfvf/8sCi9OEpJEe/xYOhLFaPumtcJAB5mKrdaKsH\
XBKJaxJInJsiA6eB67d6SESXG/q1H8f00VLxIAKLK32z5Uahuzc9HQvl4dya+dAI\
Xcw0TJg+JoBIqv5ATlcoXKqguiAyQdG2nW5nRnArhvCl9blKjg26cjbhiJcVEZCf\
z8vv56IEPhvYEtA8OaiP6vEquqA+vwNipKxqhLzfsjgqYMf18PtrftHjn7nkIvlW\
RMnG4+IbAgMBAAECggEAXZf+171UKZDiWwBAxQDZmi6yNtf3TI4tSY8RmJa47IDB\
DzkaQI5KgCf/xZvOLqjpTasI0Cj8MDoDVJ4Yy8aTVmim304kyPUz/RtZufgCi/ba\
+k371gG7ukckx6DNe8fcsIc9tVHTx3HZvFCe6tHoyUE2AjrPsmUzfDOB9cB5nLrc\
JFyKVRUwByeG76AgDJaYMq6cK53+GZih3F9e2exxdnlBuk11R2yJMr638yOfgYbY\
9vzq49OvleLEH1AdAxkcNYuUiPNC7KUeS84MAn+Ok65WvSlyJC3IjVS+swv4p/SB\
u0S38ljqisqr0qgfupEJJA/VQaXXo5NJDw48TDuEAQKBgQDuFt7sCoDyqm7XwzWf\
f9t9VFnPrLjJbNF7ll2zNlzfArzwk6cDrps2sXoNY0r37ObAdK+awWYRDyoCXJCe\
t1wP/leYMp8opn2axQVHSJCq8K2fZO3xRn98p6jy9Hub0l2r9EN6v3JGQmPffl03\
qrtYvU8as1ppUXj8Rgw4EGOWRQKBgQDKD7LJ5l/GXotYdOW93y/AXKmEzUjfi1gN\
QMxu4TxvK4Q5+CjALYtXb0swbOd7ThcYTU1vgD2Vf5t4z8L/0gSRssGxmMOw8UaS\
lay3ONFPRUhffzCMB4wkaomt1km3t9J1LJJ8h8131x2604MrIKmPMIAU6wnikdNN\
G5VXx6HM3wKBgQCBzqBdiuCA7WEfa8PJoTj23M1Wh7H7x8NyoSmW8tWxlNmURLwz\
KrhfGmYT9IXEJDouxa+ULUtLk7vwq60Bi7C6243AYiEaVaN3hWF6WtrdB/lxROLh\
v/Dz8qkPRTI7Y3dEsBk2TDiui7XN/SQvnHsmR5hgU1bAwvW2fS5eRrk1DQKBgQCf\
Dq55ukwoNiJQtmxnA3puXULgFEzKE8FzZU/H9KuDA2lpzIwfg3qNkEFK1F9/s+AA\
NFHBdNyFg1baSgnBIQyRuHo6l/trnPIlz4aPED3LvckTy2ZmxEYwIGFSoz2STjRw\
Im8JcklujbqMZ5V4bJSs78vTK5WzcYE40H7GA5K9VwKBgQCMNL9R7GUGxfQaOxiI\
4mjwus2eQ0fEodIXfU5XFppScHgtKhPWNWNfbrSICyFkfvGBBgQDLCZgt/fO+GAK\
r0kIP0GD3KvsLVHsSTR6Fsnz+05HYUEwbc6ebjOegJu+ZO9C4MXnWIaiOzd6vxUz\
UIOZiBd7mcNJ6ccxdZ39YIPTew==\
-----END PRIVATE KEY-----";

#[tokio::main]
async fn main() {
    println!("===");
    println!("VSS JWT Authentication Integration Test");
    println!("Testing against VSS server at {}", VSS_URL);
    println!();
    
    let mut passed = 0;
    let mut failed = 0;
    
    let client = Client::new();
    
    if test_valid_jwt_http(&client).await {
        passed += 1;
    } else {
        failed += 1;
    }
    
    if test_invalid_jwt_http(&client).await {
        passed += 1;
    } else {
        failed += 1;
    }
    
    println!();
    println!("Results: {} passed, {} failed", passed, failed);
    if failed > 0 {
        std::process::exit(1);
    }
}

async fn test_valid_jwt_http(client: &Client) -> bool {
    print!("test_valid_jwt_http ... ");
    
    let start_time = std::time::Instant::now();
    
    // Generate a valid JWT token (simulating lnurl-server)
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() as i64;
    let test_pubkey = "02a1b2c3d4e5f6789abcdef0123456789abcdef0123456789abcdef0123456789a";
    
    let claims = TestClaims {
        sub: test_pubkey.to_string(),
        iat: now,
        nbf: now,
        exp: now + 24 * 60 * 60, // 24 hours
    };
    
    let private_key = match fs::read_to_string(VALID_PRIVATE_KEY_PATH) {
        Ok(key) => key,
        Err(e) => {
            let duration = start_time.elapsed();
            println!("FAILED ({:?}) - Failed to load private key: {:?}", duration, e);
            return false;
        }
    };
    
    let encoding_key = match EncodingKey::from_rsa_pem(private_key.as_bytes()) {
        Ok(key) => key,
        Err(e) => {
            let duration = start_time.elapsed();
            println!("FAILED ({:?}) - Failed to create encoding key: {:?}", duration, e);
            return false;
        }
    };
    
    let jwt_token = match encode(&Header::new(Algorithm::RS256), &claims, &encoding_key) {
        Ok(token) => token,
        Err(e) => {
            let duration = start_time.elapsed();
            println!("FAILED ({:?}) - Failed to encode JWT: {:?}", duration, e);
            return false;
        }
    };
    
    let list_request = ListKeyVersionsRequest {
        store_id: "test_store".to_string(),
        key_prefix: Some("test_".to_string()),
        page_size: Some(10),
        page_token: None,
    };
    
    // Make HTTP request to VSS server
    let response = client
        .post(&format!("{}/vss/listKeyVersions", VSS_URL))
        .header("Authorization", format!("Bearer {}", jwt_token))
        .header("Content-Type", "application/x-protobuf")
        .body(list_request.encode_to_vec())
        .send()
        .await;
    
    match response {
        Ok(resp) => {
            let status = resp.status();
            let duration = start_time.elapsed();
            
            if status.is_success() {
                println!("ok ({:?}) - Status: {}", duration, status);
                true
            } else if status.as_u16() == 401 || status.as_u16() == 403 {
                println!("FAILED ({:?}) - Auth failed with status: {}", duration, status);
                false
            } else {
                println!("FAILED ({:?}) - Server error with status: {}", duration, status);
                false
            }
        },
        Err(e) => {
            let duration = start_time.elapsed();
            println!("FAILED ({:?}) - HTTP request failed: {:?}", duration, e);
            false
        }
    }
}

async fn test_invalid_jwt_http(client: &Client) -> bool {
    print!("test_invalid_jwt_http ... ");
    
    let start_time = std::time::Instant::now();
    
    // Generate a JWT token signed with a DIFFERENT key (should be rejected)
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() as i64;
    let test_pubkey = "02a1b2c3d4e5f6789abcdef0123456789abcdef0123456789abcdef0123456789a";
    
    let claims = TestClaims {
        sub: test_pubkey.to_string(),
        iat: now,
        nbf: now,
        exp: now + 24 * 60 * 60, // 24 hours
    };
    
    let invalid_encoding_key = match EncodingKey::from_rsa_pem(INVALID_PRIVATE_KEY.as_bytes()) {
        Ok(key) => key,
        Err(e) => {
            let duration = start_time.elapsed();
            println!("FAILED ({:?}) - Failed to create invalid encoding key: {:?}", duration, e);
            return false;
        }
    };
    
    let invalid_jwt_token = match encode(&Header::new(Algorithm::RS256), &claims, &invalid_encoding_key) {
        Ok(token) => token,
        Err(e) => {
            let duration = start_time.elapsed();
            println!("FAILED ({:?}) - Failed to encode invalid JWT: {:?}", duration, e);
            return false;
        }
    };

    let list_request = ListKeyVersionsRequest {
        store_id: "test_store".to_string(),
        key_prefix: Some("test_".to_string()),
        page_size: Some(10),
        page_token: None,
    };
    
    // Make HTTP request to VSS server with invalid JWT
    let response = client
        .post(&format!("{}/vss/listKeyVersions", VSS_URL))
        .header("Authorization", format!("Bearer {}", invalid_jwt_token))
        .header("Content-Type", "application/x-protobuf")
        .body(list_request.encode_to_vec())
        .send()
        .await;
    
    match response {
        Ok(resp) => {
            let status = resp.status();
            let duration = start_time.elapsed();
            
            if status.as_u16() == 401 || status.as_u16() == 403 {
                println!("ok ({:?}) - Status: {}", duration, status);
                true
            } else if status.is_success() {
                println!("FAILED ({:?}) - Should have rejected invalid JWT but got: {}", duration, status);
                false
            } else {
                println!("FAILED ({:?}) - Unexpected status: {}", duration, status);
                false
            }
        },
        Err(e) => {
            let duration = start_time.elapsed();
            println!("FAILED ({:?}) - HTTP request failed: {:?}", duration, e);
            false
        }
    }
}