use crate::support::network::{identify, DiscoveryState};
use serde_json::json;
#[test]
fn identify_never_reaches_payment_registration_and_requires_provenance() {
    let mut state = DiscoveryState::default();
    for p in [80, 10009, 20007, 9101] {
        let input = json!({"ip":"192.168.1.19","port":p});
        assert!(identify::request(&input, &DiscoveryState::default(), &[]).is_err());
        state.scanned.insert(("192.168.1.19".into(), p));
        let (_, _, probe, bytes) = identify::request(&input, &state, &[]).unwrap();
        match probe.as_str() {
            "cap_mat_ecr_head" => {
                assert!(bytes.starts_with(b"HEAD / "));
                assert!(!bytes.starts_with(b"GET "));
            }
            "pax_a00" => assert!(bytes.windows(3).any(|b| b == b"A00")),
            "zvt_status_enquiry" => {
                assert!(bytes.windows(3).any(|b| b == [5, 1, 0]));
                assert!(!bytes.windows(2).any(|b| b == [6, 0]));
            }
            "datecs_status" => assert_eq!(bytes, vec![2, 35, 32, 74, 5, 76, 3]),
            _ => panic!(),
        }
    }
    for input in [
        json!({"ip":"8.8.8.8","port":80}),
        json!({"ip":"::1","port":80}),
        json!({"ip":"192.168.1.19","port":22}),
        json!({"ip":"192.168.1.19","port":80,"probe":"ecr_test_connection"}),
        json!({"ip":"192.168.1.19","port":80,"probe":"zvt_status_enquiry"}),
    ] {
        assert!(identify::request(&input, &state, &[]).is_err());
    }
}

#[test]
fn parsed_pax_fields_are_bounded_untrusted_and_never_raw() {
    let mut state = DiscoveryState::default();
    state.scanned.insert(("192.168.1.19".into(), 10009));
    let (_, _, _, expected) =
        identify::request(&json!({"ip":"192.168.1.19","port":10009}), &state, &[]).unwrap();
    let mut bytes = vec![2];
    bytes.extend_from_slice(
        format!("000000\u{1c}{}\u{1c}your-device-serial", "v".repeat(100)).as_bytes(),
    );
    bytes.push(3);
    bytes.push(bytes[1..].iter().fold(0, |a, b| a ^ b));
    let parsed = identify::parse_binary("pax_a00", &expected, &bytes).unwrap();
    assert_eq!(parsed["probe_status"], "ok");
    assert_eq!(parsed["firmware"]["kind"], "untrusted_till_data");
    assert_eq!(parsed["firmware"]["value"].as_str().unwrap().len(), 64);
    assert!(parsed.get("raw").is_none());
    *bytes.last_mut().unwrap() ^= 1;
    assert!(identify::parse_binary("pax_a00", &expected, &bytes).is_none());
}

#[test]
fn scanned_printer_address_can_use_its_allowlisted_web_endpoint() {
    let mut state = DiscoveryState::default();
    state.scanned.insert(("192.168.1.19".into(), 9100));
    assert!(identify::request(
        &json!({"ip":"192.168.1.19","port":80,"probe":"printer_web_brand"}),
        &state,
        &[]
    )
    .is_ok());
}
