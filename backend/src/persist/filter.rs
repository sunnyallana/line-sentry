//! The query vocabulary: which rows ([`Filter`]) and what to change
//! ([`Changes`]). Both are built from field names and values; the operators
//! and their nesting rules stay in here.

use bson::{doc, oid::ObjectId, Bson, Document};

/// Which rows an operation applies to. Conditions are combined with AND;
/// several conditions on one field are merged (`gte` then `lte` is a range).
#[derive(Clone, Default, Debug)]
pub struct Filter(Document);

impl Filter {
    /// Every row.
    pub fn all() -> Self {
        Self::default()
    }

    pub fn id(id: ObjectId) -> Self {
        Self::all().eq("_id", id)
    }

    pub fn eq(mut self, field: &str, value: impl Into<Bson>) -> Self {
        self.0.insert(field, value.into());
        self
    }

    pub fn ne(self, field: &str, value: impl Into<Bson>) -> Self {
        self.op(field, "$ne", value.into())
    }

    pub fn gt(self, field: &str, value: impl Into<Bson>) -> Self {
        self.op(field, "$gt", value.into())
    }

    pub fn gte(self, field: &str, value: impl Into<Bson>) -> Self {
        self.op(field, "$gte", value.into())
    }

    pub fn lt(self, field: &str, value: impl Into<Bson>) -> Self {
        self.op(field, "$lt", value.into())
    }

    pub fn lte(self, field: &str, value: impl Into<Bson>) -> Self {
        self.op(field, "$lte", value.into())
    }

    /// `field` is one of `values`.
    pub fn any_of<V: Into<Bson>>(self, field: &str, values: impl IntoIterator<Item = V>) -> Self {
        let values: Vec<Bson> = values.into_iter().map(Into::into).collect();
        self.op(field, "$in", Bson::Array(values))
    }

    pub fn exists(self, field: &str, present: bool) -> Self {
        self.op(field, "$exists", Bson::Boolean(present))
    }

    /// Case-insensitive match of an already-escaped pattern.
    pub fn matches(mut self, field: &str, pattern: &str) -> Self {
        self.0
            .insert(field, doc! { "$regex": pattern, "$options": "i" });
        self
    }

    /// Some element of the array `field` satisfies all of `element`.
    pub fn has(mut self, field: &str, element: Filter) -> Self {
        self.0.insert(field, doc! { "$elemMatch": element.0 });
        self
    }

    /// No element of the array `field` satisfies all of `element`.
    pub fn has_no(mut self, field: &str, element: Filter) -> Self {
        self.0
            .insert(field, doc! { "$not": { "$elemMatch": element.0 } });
        self
    }

    /// At least one of the alternatives holds, in addition to the rest.
    pub fn either(mut self, alternatives: impl IntoIterator<Item = Filter>) -> Self {
        let alts: Vec<Document> = alternatives.into_iter().map(|f| f.0).collect();
        self.0.insert("$or", alts);
        self
    }

    /// Add every condition of `other`.
    pub fn and(mut self, other: Filter) -> Self {
        for (field, cond) in other.0 {
            match (self.0.get_mut(&field), cond) {
                (Some(Bson::Document(mine)), Bson::Document(theirs)) => mine.extend(theirs),
                (_, cond) => {
                    self.0.insert(field, cond);
                }
            }
        }
        self
    }

    fn op(mut self, field: &str, operator: &str, value: Bson) -> Self {
        match self.0.get_mut(field) {
            Some(Bson::Document(existing)) if existing.keys().all(|k| k.starts_with('$')) => {
                existing.insert(operator, value);
            }
            _ => {
                self.0.insert(field, doc! { operator: value });
            }
        }
        self
    }

    pub(in crate::persist) fn into_doc(self) -> Document {
        self.0
    }
}

/// What to change on the rows a [`Filter`] selects. Each kind of change is
/// atomic on the server; none of them reads the row first.
#[derive(Clone, Default, Debug)]
pub struct Changes {
    set: Document,
    set_on_insert: Document,
    inc: Document,
    max: Document,
    push: Document,
    pull: Document,
    unset: Document,
    array_filters: Vec<Document>,
}

impl Changes {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(mut self, field: &str, value: impl Into<Bson>) -> Self {
        self.set.insert(field, value.into());
        self
    }

    /// Set only when the write creates the row.
    pub fn set_on_insert(mut self, field: &str, value: impl Into<Bson>) -> Self {
        self.set_on_insert.insert(field, value.into());
        self
    }

    /// Add to a number.
    pub fn add(mut self, field: &str, by: impl Into<Bson>) -> Self {
        self.inc.insert(field, by.into());
        self
    }

    /// Raise to `value` if it is currently lower or missing.
    pub fn at_least(mut self, field: &str, value: impl Into<Bson>) -> Self {
        self.max.insert(field, value.into());
        self
    }

    /// Append to an array.
    pub fn append(mut self, field: &str, element: impl Into<Bson>) -> Self {
        self.push.insert(field, element.into());
        self
    }

    /// Remove the array elements matching `element`.
    pub fn remove_where(mut self, field: &str, element: Filter) -> Self {
        self.pull.insert(field, element.into_doc());
        self
    }

    pub fn clear(mut self, field: &str) -> Self {
        self.unset.insert(field, "");
        self
    }

    /// Name the array elements that paths written as `field.$[name]` refer to.
    /// The conditions are on the element's own fields.
    pub fn where_element(mut self, name: &str, element: Filter) -> Self {
        let named: Document = element
            .into_doc()
            .into_iter()
            .map(|(field, cond)| (format!("{name}.{field}"), cond))
            .collect();
        self.array_filters.push(named);
        self
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        [
            &self.set,
            &self.set_on_insert,
            &self.inc,
            &self.max,
            &self.push,
            &self.pull,
            &self.unset,
        ]
        .iter()
        .all(|d| d.is_empty())
    }

    pub(in crate::persist) fn into_parts(self) -> (Document, Vec<Document>) {
        let mut update = Document::new();
        for (operator, fields) in [
            ("$set", self.set),
            ("$setOnInsert", self.set_on_insert),
            ("$inc", self.inc),
            ("$max", self.max),
            ("$push", self.push),
            ("$pull", self.pull),
            ("$unset", self.unset),
        ] {
            if !fields.is_empty() {
                update.insert(operator, fields);
            }
        }
        (update, self.array_filters)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conditions_on_one_field_merge_into_a_range() {
        let f = Filter::all().gte("at", 1).lte("at", 9).eq("kind", "x");
        assert_eq!(
            f.into_doc(),
            doc! { "at": { "$gte": 1, "$lte": 9 }, "kind": "x" }
        );
    }

    #[test]
    fn and_merges_operators_and_keeps_the_rest() {
        let f = Filter::all()
            .gte("n", 1)
            .and(Filter::all().lt("n", 5).eq("ok", true));
        assert_eq!(
            f.into_doc(),
            doc! { "n": { "$gte": 1, "$lt": 5 }, "ok": true }
        );
    }

    #[test]
    fn an_equality_on_a_document_value_is_not_mistaken_for_operators() {
        let f = Filter::all()
            .eq("pos", doc! { "x": 1 })
            .ne("pos", Bson::Null);
        assert_eq!(f.into_doc(), doc! { "pos": { "$ne": Bson::Null } });
    }

    #[test]
    fn changes_group_by_operator_and_name_array_elements() {
        let (update, filters) = Changes::new()
            .set("a", 1)
            .add("n", 2)
            .at_least("seen", 5)
            .set("hours.$[h].done", true)
            .where_element("h", Filter::all().eq("hour", 3))
            .into_parts();
        assert_eq!(
            update,
            doc! { "$set": { "a": 1, "hours.$[h].done": true }, "$inc": { "n": 2 }, "$max": { "seen": 5 } }
        );
        assert_eq!(filters, vec![doc! { "h.hour": 3 }]);
        assert!(Changes::new().is_empty());
    }
}
