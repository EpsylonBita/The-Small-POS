#[test]
fn replica_build_uses_its_thirty_second_cap_and_queries_keep_five_seconds() {
    use crate::support::{contracts, replica};
    assert_eq!(replica::build_budget().as_millis(), 30_000);
    assert_eq!(
        replica::build_budget().as_millis(),
        u128::from(contracts::cap("performance", "replicaBuildMs"))
    );
    assert_eq!(contracts::cap("tools", "sqlMs"), 5_000);
}
