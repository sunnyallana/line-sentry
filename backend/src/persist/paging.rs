//! Paging shared by the admin lists that join other collections.

use bson::{doc, Bson, Document};

use super::{DbResult, Entity, Persister};

/// Which page of an admin list to return, and in what order.
pub struct Slice<'a> {
    /// Field to order by; empty means the creation time.
    pub sort_by: &'a str,
    pub ascending: bool,
    pub skip: i64,
    pub limit: i64,
}

/// Run `stages`, then return the requested page of the result together with
/// the number of rows before paging, in one aggregation.
pub(super) async fn page_with_total<T: Entity>(
    rows: &Persister<T>,
    mut stages: Vec<Document>,
    slice: &Slice<'_>,
) -> DbResult<(Vec<Document>, i64)> {
    let sort_by = if slice.sort_by.is_empty() {
        "createdAt"
    } else {
        slice.sort_by
    };
    let order: i32 = if slice.ascending { 1 } else { -1 };
    // The sort sits inside the page branch so the server can keep only the
    // top rows, and the count branch does not sort at all.
    stages.push(doc! { "$facet": {
        "rows": [
            { "$sort": { sort_by: order } },
            { "$skip": slice.skip },
            { "$limit": slice.limit },
        ],
        "total": [{ "$count": "total" }],
    }});
    let Some(mut facet) = rows.aggregate(stages).await?.into_iter().next() else {
        return Ok((Vec::new(), 0));
    };
    // No rows at all leaves the count branch empty.
    let total = facet
        .get_array("total")
        .ok()
        .and_then(|counts| counts.first())
        .and_then(Bson::as_document)
        .and_then(|d| {
            d.get_i32("total")
                .ok()
                .map(i64::from)
                .or_else(|| d.get_i64("total").ok())
        })
        .unwrap_or(0);
    let page = match facet.remove("rows") {
        Some(Bson::Array(page)) => page
            .into_iter()
            .filter_map(|row| match row {
                Bson::Document(d) => Some(d),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    Ok((page, total))
}
