//! Users: the accounts people log in with.

use bson::{doc, oid::ObjectId, Document};
use mongodb::Database;

use super::{Batch, Changes, DbResult, Entity, Filter, Page, Persister};
use crate::models::{User, DEPARTMENTS, USERS};

impl Entity for User {
    const COLLECTION: &'static str = USERS;
}

/// Field names.
pub mod f {
    pub const USERNAME: &str = "username";
    pub const EMAIL: &str = "email";
    pub const PASSWORD: &str = "password";
    pub const ROLE: &str = "role";
    pub const DEPARTMENT: &str = "departmentId";
    pub const ACTIVE: &str = "isActive";
    pub const CREATED: &str = "createdAt";
    pub const UPDATED: &str = "updatedAt";
}

pub const ADMIN: &str = "admin";
pub const OPERATOR: &str = "operator";

/// Which accounts an admin list shows. Unset parts do not narrow it.
#[derive(Default)]
pub struct Search {
    /// Already-escaped pattern looked for in the username and the email.
    pub text: Option<String>,
    pub role: Option<String>,
    pub department: Option<ObjectId>,
    pub active: Option<bool>,
}

impl Search {
    fn into_filter(self) -> Filter {
        let mut filter = Filter::all();
        if let Some(pattern) = &self.text {
            filter = filter.either([
                Filter::all().matches(f::USERNAME, pattern),
                Filter::all().matches(f::EMAIL, pattern),
            ]);
        }
        if let Some(role) = self.role {
            filter = filter.eq(f::ROLE, role);
        }
        if let Some(department) = self.department {
            filter = filter.eq(f::DEPARTMENT, department);
        }
        if let Some(active) = self.active {
            filter = filter.eq(f::ACTIVE, active);
        }
        filter
    }
}

/// What happens to an account's department in an [`Edit`].
#[derive(Default)]
pub enum DepartmentEdit {
    #[default]
    Keep,
    Clear,
    Assign(ObjectId),
}

/// The parts of an account an admin may change. Unset parts are left alone.
#[derive(Default)]
pub struct Edit {
    pub username: Option<String>,
    pub email: Option<String>,
    pub role: Option<String>,
    pub department: DepartmentEdit,
    pub active: Option<bool>,
    pub password_hash: Option<String>,
}

/// A login to create, or to reset if the username is already there.
pub struct Account<'a> {
    pub username: &'a str,
    pub email: &'a str,
    pub password_hash: String,
    pub role: &'a str,
    pub department: Option<ObjectId>,
}

/// The unique value a rejected write collided on.
pub enum Taken {
    Username,
    Email,
    Other,
}

/// Which unique value `e` reports as taken, if that is what it is. Reads the
/// index name out of the server's message. An insert reports a collision as a
/// write error and a find-and-modify as a command error; both are recognised.
pub fn taken(e: &mongodb::error::Error) -> Option<Taken> {
    use mongodb::error::{ErrorKind, WriteFailure};
    let (code, message) = match e.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(we)) => (we.code, &we.message),
        ErrorKind::Command(ce) => (ce.code, &ce.message),
        _ => return None,
    };
    if code != 11000 {
        return None;
    }
    let message = message.to_lowercase();
    Some(if message.contains(f::USERNAME) {
        Taken::Username
    } else if message.contains(f::EMAIL) {
        Taken::Email
    } else {
        Taken::Other
    })
}

/// Stages that put `{ _id, name }` of the department where its id was, and
/// drop the password hash.
fn with_department_name() -> [Document; 3] {
    [
        doc! { "$lookup": {
            "from": DEPARTMENTS,
            "localField": f::DEPARTMENT,
            "foreignField": "_id",
            "as": f::DEPARTMENT,
            "pipeline": [ { "$project": { super::departments::f::NAME: 1 } } ],
        }},
        doc! { "$unwind": {
            "path": format!("${}", f::DEPARTMENT),
            "preserveNullAndEmptyArrays": true,
        }},
        doc! { "$project": { f::PASSWORD: 0 } },
    ]
}

pub struct Users {
    pub rows: Persister<User>,
}

impl Users {
    pub fn new(db: &Database) -> Self {
        Self {
            rows: Persister::new(db),
        }
    }

    pub async fn by_id(&self, id: ObjectId) -> DbResult<Option<User>> {
        self.rows.get(id).await
    }

    pub async fn by_username(&self, username: &str) -> DbResult<Option<User>> {
        self.rows
            .find_one(Filter::all().eq(f::USERNAME, username))
            .await
    }

    /// Active accounts, optionally of one department, each with its
    /// department's name and without its password hash.
    pub async fn active_with_department(
        &self,
        department: Option<ObjectId>,
    ) -> DbResult<Vec<Document>> {
        let mut filter = Filter::all().eq(f::ACTIVE, true);
        if let Some(d) = department {
            filter = filter.eq(f::DEPARTMENT, d);
        }
        let mut stages = vec![doc! { "$match": filter.into_doc() }];
        stages.extend(with_department_name());
        self.rows.aggregate(stages).await
    }

    /// One page of the accounts matching `search`, shaped as
    /// [`Users::active_with_department`] shapes them, and how many match in
    /// all. The page is cut after the department is joined so that it can be
    /// sorted by the department's fields too.
    pub async fn search(&self, search: Search, page: Page) -> DbResult<(Vec<Document>, u64)> {
        let filter = search.into_filter();
        let mut stages = vec![doc! { "$match": filter.clone().into_doc() }];
        stages.extend(with_department_name());
        stages.extend(page.into_stages());
        futures::future::try_join(self.rows.aggregate(stages), self.rows.count(filter)).await
    }

    /// Returns the new account's id. A taken username or email is an error
    /// that [`taken`] recognises.
    pub async fn create(&self, user: &User) -> DbResult<ObjectId> {
        self.rows.insert(user).await
    }

    /// Apply `edit` and return the account as it is afterwards, or `None` if
    /// there is no such account.
    pub async fn edit(&self, id: ObjectId, edit: Edit) -> DbResult<Option<User>> {
        let mut changes = Changes::new();
        if let Some(username) = edit.username {
            changes = changes.set(f::USERNAME, username);
        }
        if let Some(email) = edit.email {
            changes = changes.set(f::EMAIL, email);
        }
        if let Some(role) = edit.role {
            changes = changes.set(f::ROLE, role);
        }
        changes = match edit.department {
            DepartmentEdit::Keep => changes,
            DepartmentEdit::Clear => changes.clear(f::DEPARTMENT),
            DepartmentEdit::Assign(department) => changes.set(f::DEPARTMENT, department),
        };
        if let Some(active) = edit.active {
            changes = changes.set(f::ACTIVE, active);
        }
        if let Some(hash) = edit.password_hash {
            changes = changes.set(f::PASSWORD, hash);
        }
        changes = changes.set(f::UPDATED, bson::DateTime::now());
        self.rows.update_returning(Filter::id(id), changes).await
    }

    /// Returns whether there was such an account.
    pub async fn remove(&self, id: ObjectId) -> DbResult<bool> {
        Ok(self.rows.delete(Filter::id(id)).await? == 1)
    }

    /// Queue creating `account`, or resetting the one with its username.
    pub fn queue_account(&self, batch: &mut Batch, account: Account<'_>) -> usize {
        let mut changes = Changes::new()
            .set(f::EMAIL, account.email)
            .set(f::PASSWORD, account.password_hash)
            .set(f::ROLE, account.role);
        if let Some(department) = account.department {
            changes = changes.set(f::DEPARTMENT, department);
        }
        batch.upsert(
            &self.rows,
            Filter::all().eq(f::USERNAME, account.username),
            changes.set(f::ACTIVE, true),
        )
    }
}
