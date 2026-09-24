# ADManager Plus REST API Specification

> **Source:** https://www.manageengine.com/products/ad-manager/active-directory-api/  
> **API Version:** V2  
> **Base URL:** `http://<admanagerplus-host>:8080/api/v2`  
> **OpenAPI Download:** https://www.manageengine.com/products/ad-manager/active-directory-api/v2/openapi-all.zip

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Rate Limits](#rate-limits)
4. [HTTP Methods & Status Codes](#http-methods--status-codes)
5. [Pagination](#pagination)
6. [Filtering](#filtering)
7. [Scopes](#scopes)
8. [API Endpoints](#api-endpoints)
   - [User Management](#user-management)
   - [Group Management](#group-management)
   - [Computer Management](#computer-management)
   - [Contact Management](#contact-management)
   - [OU Management](#ou-management)
   - [Domain Management](#domain-management)
   - [AuthToken Management](#authtoken-management)
   - [Orchestration](#orchestration)
   - [Admin Settings](#admin-settings)
   - [Workflow](#workflow)
9. [Error Codes](#error-codes)

---

## Overview

ADManager Plus exposes a REST API that enables integration of Active Directory management functions — user provisioning, group management, password reset, and more — with external applications such as help desk tools, HR systems, and custom automation.

The API is:

- **Consistent** — clean REST endpoints with predictable JSON responses
- **Flexible** — supports full CRUD operations and action-based workflows
- **Secure** — requires authorization tokens on every request
- **Scalable** — enforces rate limits to protect service stability

---

## Authentication

All API requests must include an `Authorization` header containing a valid authtoken. Tokens **cannot** be passed as query parameters.

```
Authorization: <your_authtoken>
```

### Generating an Authtoken (Technician)

1. Log in to ADManager Plus as a technician.
2. Navigate to **My Account → Active Authtokens**.
3. Click **+ Generate Authtoken**.
4. Fill in:
   - **Technician** — the account the token is for
   - **Authtoken Name** — a descriptive label
   - **Scope** — limits the operations this token may perform (see [Scopes](#scopes))
   - **Expiry Time** — in minutes, hours, days, or a custom date
5. Click **Generate Authtoken**.

### Generating an Authtoken (Built-in Admin)

Navigate to **Delegation → Configuration → Technician Authtokens** to create, view, and revoke tokens for any technician.

---

## Rate Limits

| Request Type                 | Limit                                                          |
| ---------------------------- | -------------------------------------------------------------- |
| Read (GET)                   | 100 requests / minute across all GET endpoints                 |
| Action (POST, PATCH, DELETE) | 50 requests / minute across all non-GET endpoints              |
| Custom limits                | Some endpoints enforce stricter limits; see per-endpoint notes |

Monitor usage at: **Admin → System Settings → Integrations → Rest API**

---

## HTTP Methods & Status Codes

### Methods

| Method | Purpose                                                                    |
| ------ | -------------------------------------------------------------------------- |
| GET    | Retrieve resources (e.g., list users, fetch group details)                 |
| POST   | Create resources or trigger actions (e.g., create user, reset password)    |
| PATCH  | Partially update an existing resource (e.g., update a user's phone number) |
| DELETE | Remove an existing resource (e.g., delete a group)                         |

### Status Codes

| Code | Message               | Meaning                                                        |
| ---- | --------------------- | -------------------------------------------------------------- |
| 200  | OK                    | Request succeeded; data returned                               |
| 201  | Created               | Resource was successfully created                              |
| 400  | Bad Request           | Invalid input, missing parameters, or incorrect field values   |
| 401  | Unauthorized          | Missing, expired, or invalid token; or insufficient delegation |
| 404  | Not Found             | Resource does not exist                                        |
| 405  | Method Not Allowed    | HTTP method is not supported on this endpoint                  |
| 500  | Internal Server Error | Unexpected server-side error                                   |

---

## Pagination

ADManager Plus uses **offset-based pagination** on list endpoints.

| Query Parameter | Type    | Description                                  |
| --------------- | ------- | -------------------------------------------- |
| `offset`        | integer | Zero-based starting index of results         |
| `limit`         | integer | Maximum number of results to return per page |

**Example:**

```
GET /api/v2/users?offset=0&limit=50
```

---

## Filtering

List endpoints support a filter query parameter using a structured expression syntax.

| Operator Type | Operators                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------- |
| Attribute     | `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `sw` (starts with), `ew` (ends with), `co` (contains) |
| Logical       | `and`, `or`, `not`                                                                        |
| Grouping      | `(` `)` parentheses for precedence                                                        |

**Example:**

```
GET /api/v2/users?filter=department eq "Engineering" and enabled eq true
```

---

## Scopes

Authtokens can be scoped to limit which operations they are authorized to perform.

| Scope                        | Permitted Operations                             |
| ---------------------------- | ------------------------------------------------ |
| `user`                       | All user management actions                      |
| `user:read`                  | Read/search users                                |
| `user:create`                | Create users                                     |
| `user:modify`                | Update users                                     |
| `user:delete`                | Delete users                                     |
| `group`                      | All group management actions                     |
| `group:read`                 | Read/search groups                               |
| `group:create`               | Create groups                                    |
| `group:modify`               | Update groups                                    |
| `group:delete`               | Delete groups                                    |
| `computer`                   | All computer management actions                  |
| `computer:read`              | Read/search computers                            |
| `computer:create`            | Create computers                                 |
| `computer:modify`            | Update computers                                 |
| `computer:delete`            | Delete computers                                 |
| `contact`                    | All contact management actions                   |
| `contact:read`               | Read/search contacts                             |
| `contact:create`             | Create contacts                                  |
| `contact:modify`             | Update contacts                                  |
| `contact:delete`             | Delete contacts                                  |
| `organizational-unit`        | All OU management actions                        |
| `organizational-unit:read`   | Read/search OUs                                  |
| `organizational-unit:create` | Create OUs                                       |
| `organizational-unit:modify` | Update OUs                                       |
| `organizational-unit:delete` | Delete OUs                                       |
| `orchestration`              | All orchestration actions                        |
| `orchestration:read`         | Read orchestration templates                     |
| `orchestration:run`          | Execute orchestration templates                  |
| `admin-settings`             | All admin settings actions                       |
| `admin-settings:env:read`    | Read environment variables                       |
| `admin-settings:env:add`     | Add environment variables                        |
| `admin-settings:env:update`  | Update environment variables                     |
| `admin-settings:org:read`    | Read organization attributes                     |
| `admin-settings:org:add`     | Add organization attributes                      |
| `admin-settings:org:delete`  | Delete organization attributes                   |
| `directory-data`             | All directory data actions (built-in admin only) |

---

## API Endpoints

### User Management

> Min build: **6583** for core operations; **7040+** for group-add/remove; **7200+** for move

---

#### List / Search Users

```
GET /api/v2/users
```

Search for and retrieve user accounts in AD.

**Query Parameters:**

| Parameter    | Type    | Description                                  |
| ------------ | ------- | -------------------------------------------- |
| `filter`     | string  | Filter expression (see Filtering)            |
| `offset`     | integer | Pagination offset                            |
| `limit`      | integer | Max results per page                         |
| `columns`    | string  | Comma-separated list of attributes to return |
| `domainName` | string  | Target AD domain                             |

**Response:** `200 OK` — JSON array of user objects

---

#### Create User

```
POST /api/v2/users
```

Create a new user account in AD.

**Headers:** `Authorization: <token>`, `Content-Type: application/json`

**Request Body (JSON):**

| Field               | Type    | Required | Description                           |
| ------------------- | ------- | -------- | ------------------------------------- |
| `domainName`        | string  | Yes      | Target AD domain                      |
| `ouPath`            | string  | Yes      | DN of the target OU                   |
| `firstName`         | string  | Yes      | User's first name                     |
| `lastName`          | string  | Yes      | User's last name                      |
| `sAMAccountName`    | string  | Yes      | Logon name (pre-Windows 2000)         |
| `userPrincipalName` | string  | Yes      | UPN (user@domain)                     |
| `password`          | string  | Yes      | Initial password                      |
| `enabled`           | boolean | No       | Account enabled state (default: true) |
| `email`             | string  | No       | Email address                         |
| `department`        | string  | No       | Department                            |
| `title`             | string  | No       | Job title                             |
| `telephoneNumber`   | string  | No       | Phone number                          |

**Response:** `201 Created`

---

#### Update (Modify) User Attributes

```
PATCH /api/v2/users/{sAMAccountName}
```

Update one or more attributes of an existing user.

**Path Parameters:**

| Parameter        | Type   | Description                   |
| ---------------- | ------ | ----------------------------- |
| `sAMAccountName` | string | Logon name of the target user |

**Request Body:** JSON object containing only the fields to be updated.

**Response:** `200 OK`

---

#### Delete User

```
POST /api/v1/user/deleteUserAccount
```

Delete a user account from AD. _(V1 legacy endpoint)_

**Request Body (form/JSON):**

| Field        | Type   | Required | Description                      |
| ------------ | ------ | -------- | -------------------------------- |
| `domainName` | string | Yes      | AD domain                        |
| `userName`   | string | Yes      | sAMAccountName of user to delete |
| `authToken`  | string | Yes      | Auth token (if not in header)    |

**Response:** `200 OK` with status message

---

#### Disable User

```
POST /api/v1/user/disableUserAccount
```

Disable an enabled AD user account.

**Request Body:**

| Field        | Type   | Required |
| ------------ | ------ | -------- |
| `domainName` | string | Yes      |
| `userName`   | string | Yes      |

---

#### Enable User

```
POST /api/v1/user/enableUserAccount
```

Enable a disabled AD user account.

**Request Body:** Same as Disable User.

---

#### Reset User Password

```
POST /api/v1/user/resetPassword
```

Reset the password of a user account.

**Request Body:**

| Field                | Type    | Required | Description                  |
| -------------------- | ------- | -------- | ---------------------------- |
| `domainName`         | string  | Yes      | AD domain                    |
| `userName`           | string  | Yes      | Target user's sAMAccountName |
| `newPassword`        | string  | Yes      | New password                 |
| `mustChangePassword` | boolean | No       | Force change at next logon   |

---

#### Unlock User

```
POST /api/v1/user/unlockUserAccount
```

Unlock a locked-out user account.

**Request Body:**

| Field        | Type   | Required |
| ------------ | ------ | -------- |
| `domainName` | string | Yes      |
| `userName`   | string | Yes      |

---

#### Move User

```
POST /api/v1/user/moveUserAccount
```

Move a user to a different OU/container. _(Min build: 7200)_

**Request Body:**

| Field        | Type   | Required | Description              |
| ------------ | ------ | -------- | ------------------------ |
| `domainName` | string | Yes      | AD domain                |
| `userName`   | string | Yes      | sAMAccountName           |
| `targetOU`   | string | Yes      | DN of the destination OU |

---

#### Add Users to Groups

```
POST /api/v1/user/addUsersToGroups
```

Add one or more user accounts to one or more AD groups. _(Min build: 7040)_

**Request Body:**

| Field        | Type     | Required | Description             |
| ------------ | -------- | -------- | ----------------------- |
| `domainName` | string   | Yes      | AD domain               |
| `userNames`  | string[] | Yes      | List of sAMAccountNames |
| `groupNames` | string[] | Yes      | List of group names     |

---

#### Remove Users from Groups

```
POST /api/v1/user/removeUsersFromGroups
```

Remove user accounts from AD groups. _(Min build: 7040)_

**Request Body:** Same structure as Add Users to Groups.

---

### Group Management

> Min build: **7180** for core operations; **8030** for update

---

#### List / Search Groups

```
GET /api/v2/groups
```

Search for groups in AD.

**Query Parameters:** `filter`, `offset`, `limit`, `columns`, `domainName`

---

#### List Group Members

```
GET /api/v1/group/listGroupMembers
```

List the member accounts of an AD group.

**Query Parameters:**

| Parameter    | Type   | Required | Description              |
| ------------ | ------ | -------- | ------------------------ |
| `domainName` | string | Yes      | AD domain                |
| `groupName`  | string | Yes      | Name of the target group |

---

#### Create Group

```
POST /api/v1/group/createGroup
```

Create a new group in AD.

**Request Body:**

| Field         | Type   | Required | Description                          |
| ------------- | ------ | -------- | ------------------------------------ |
| `domainName`  | string | Yes      | AD domain                            |
| `ouPath`      | string | Yes      | DN of target OU                      |
| `groupName`   | string | Yes      | Name of the new group                |
| `groupScope`  | string | No       | `Global`, `Universal`, `DomainLocal` |
| `groupType`   | string | No       | `Security`, `Distribution`           |
| `description` | string | No       | Group description                    |

---

#### Update Group

```
PATCH /api/v2/groups/{groupName}
```

Update attributes of an existing AD group. _(Min build: 8030)_

---

#### Delete Group

```
POST /api/v1/group/deleteGroup
```

Delete an AD group.

**Request Body:**

| Field        | Type   | Required |
| ------------ | ------ | -------- |
| `domainName` | string | Yes      |
| `groupName`  | string | Yes      |

---

#### Move Group

```
POST /api/v1/group/moveGroup
```

Move a group to a different OU.

**Request Body:**

| Field        | Type   | Required | Description          |
| ------------ | ------ | -------- | -------------------- |
| `domainName` | string | Yes      |                      |
| `groupName`  | string | Yes      |                      |
| `targetOU`   | string | Yes      | DN of destination OU |

---

### Computer Management

> Min build: **7200** for core; **8030** for create/update/disable

---

#### List / Search Computers

```
GET /api/v2/computers
```

Search for computer accounts in AD.

**Query Parameters:** `filter`, `offset`, `limit`, `columns`, `domainName`

---

#### Create Computer

```
POST /api/v2/computers
```

Add a new computer account in AD. _(Min build: 8030)_

**Request Body:**

| Field          | Type   | Required | Description           |
| -------------- | ------ | -------- | --------------------- |
| `domainName`   | string | Yes      | AD domain             |
| `ouPath`       | string | Yes      | DN of target OU       |
| `computerName` | string | Yes      | Computer account name |
| `description`  | string | No       | Description           |

---

#### Update Computer

```
PATCH /api/v2/computers/{computerName}
```

Update attributes of a computer account. _(Min build: 8030)_

---

#### Disable Computer

```
PATCH /api/v2/computers/{computerName}/disable
```

Disable a computer account in AD. _(Min build: 7200)_

---

#### Enable Computer

```
POST /api/v1/computer/enableComputer
```

Enable a disabled computer account.

**Request Body:**

| Field          | Type   | Required |
| -------------- | ------ | -------- |
| `domainName`   | string | Yes      |
| `computerName` | string | Yes      |

---

#### Move Computer

```
POST /api/v1/computer/moveComputer
```

Move a computer to another OU.

**Request Body:**

| Field          | Type   | Required | Description          |
| -------------- | ------ | -------- | -------------------- |
| `domainName`   | string | Yes      |                      |
| `computerName` | string | Yes      |                      |
| `targetOU`     | string | Yes      | DN of destination OU |

---

#### Delete Computer

```
POST /api/v1/computer/deleteComputer
```

Delete a computer account from AD.

---

#### Add Computers to Groups

```
POST /api/v1/computer/addComputersToGroups
```

Add computers to one or more AD groups.

**Request Body:**

| Field           | Type     | Required |
| --------------- | -------- | -------- |
| `domainName`    | string   | Yes      |
| `computerNames` | string[] | Yes      |
| `groupNames`    | string[] | Yes      |

---

#### Remove Computers from Groups

```
POST /api/v1/computer/removeComputersFromGroups
```

Remove computers from AD groups. Same body structure as above.

---

### Contact Management

> Min build: **8030**

---

#### List Contacts

```
GET /api/v2/contacts
```

#### Create Contact

```
POST /api/v2/contacts
```

**Request Body:**

| Field             | Type   | Required |
| ----------------- | ------ | -------- |
| `domainName`      | string | Yes      |
| `ouPath`          | string | Yes      |
| `displayName`     | string | Yes      |
| `email`           | string | No       |
| `firstName`       | string | No       |
| `lastName`        | string | No       |
| `telephoneNumber` | string | No       |

#### Update Contact

```
PATCH /api/v2/contacts/{contactId}
```

#### Delete Contact

```
DELETE /api/v2/contacts/{contactId}
```

---

### OU Management

> Min build: **7010** for create; **7200** for search/delete; **8030** for update

---

#### List OUs

```
GET /api/v2/ous
```

Search for OUs in AD. **Query Parameters:** `filter`, `offset`, `limit`, `domainName`

#### Create OU

```
POST /api/v1/ou/createOU
```

**Request Body:**

| Field         | Type   | Required | Description        |
| ------------- | ------ | -------- | ------------------ |
| `domainName`  | string | Yes      |                    |
| `parentOU`    | string | Yes      | DN of parent OU    |
| `ouName`      | string | Yes      | Name of the new OU |
| `description` | string | No       |                    |

#### Update OU

```
PATCH /api/v2/ous/{ouId}
```

_(Min build: 8030)_

#### Delete OU

```
POST /api/v1/ou/deleteOU
```

**Request Body:**

| Field        | Type   | Required |
| ------------ | ------ | -------- |
| `domainName` | string | Yes      |
| `ouPath`     | string | Yes      |

---

### Domain Management

> Min build: **7040** for update; **7180** for list

---

#### List Domains

```
GET /api/v1/domain/listDomains
```

Returns all domains configured in ADManager Plus.

**Response:** `200 OK` — JSON array of domain objects

---

#### Update Domain Settings

```
POST /api/v1/domain/updateDomainSettings
```

**Request Body:**

| Field        | Type   | Required | Description                         |
| ------------ | ------ | -------- | ----------------------------------- |
| `domainName` | string | Yes      | Domain to update                    |
| `settings`   | object | Yes      | Key-value map of settings to update |

---

### AuthToken Management

> Min build: **7200**

---

#### Remove AuthToken

```
POST /api/v1/authtoken/removeAuthToken
```

Revoke an existing authentication token.

**Request Body:**

| Field       | Type   | Required |
| ----------- | ------ | -------- |
| `authToken` | string | Yes      |

---

### Orchestration

> Min build: **8030**

---

#### List Orchestration Templates

```
GET /api/v2/orchestration/templates
```

Retrieve available orchestration templates.

---

#### Execute Orchestration

```
POST /api/v2/orchestration/templates/{templateId}/execute
```

Run a specific orchestration template.

**Request Body:**

| Field        | Type   | Description                                     |
| ------------ | ------ | ----------------------------------------------- |
| `parameters` | object | Template input parameters (varies per template) |

**Response:** `200 OK` — includes `executionId`

---

#### Get Execution Status

```
GET /api/v2/orchestration/executions/{executionId}
```

Poll the status of an orchestration run.

**Response Fields:**

| Field         | Description                                 |
| ------------- | ------------------------------------------- |
| `executionId` | Unique ID of the run                        |
| `status`      | `pending`, `running`, `completed`, `failed` |
| `startTime`   | ISO 8601 timestamp                          |
| `endTime`     | ISO 8601 timestamp (when complete)          |
| `result`      | Output of the orchestration                 |

---

### Admin Settings

> Min build: **8030**

All admin settings endpoints follow the pattern:

```
GET    /api/v2/admin-settings/{resource}
POST   /api/v2/admin-settings/{resource}
PATCH  /api/v2/admin-settings/{resource}/{id}
DELETE /api/v2/admin-settings/{resource}/{id}
```

#### Environment Variables

| Operation | Method | Endpoint                                            |
| --------- | ------ | --------------------------------------------------- |
| List      | GET    | `/api/v2/admin-settings/environment-variables`      |
| Add       | POST   | `/api/v2/admin-settings/environment-variables`      |
| Update    | PATCH  | `/api/v2/admin-settings/environment-variables/{id}` |

#### Organization Titles

| Operation | Method | Endpoint                                          |
| --------- | ------ | ------------------------------------------------- |
| List      | GET    | `/api/v2/admin-settings/organization-titles`      |
| Add       | POST   | `/api/v2/admin-settings/organization-titles`      |
| Delete    | DELETE | `/api/v2/admin-settings/organization-titles/{id}` |

#### Organization Departments

| Operation | Method | Endpoint                                               |
| --------- | ------ | ------------------------------------------------------ |
| List      | GET    | `/api/v2/admin-settings/organization-departments`      |
| Add       | POST   | `/api/v2/admin-settings/organization-departments`      |
| Delete    | DELETE | `/api/v2/admin-settings/organization-departments/{id}` |

#### Organization Offices

| Operation | Method | Endpoint                                           |
| --------- | ------ | -------------------------------------------------- |
| List      | GET    | `/api/v2/admin-settings/organization-offices`      |
| Add       | POST   | `/api/v2/admin-settings/organization-offices`      |
| Delete    | DELETE | `/api/v2/admin-settings/organization-offices/{id}` |

#### Organization Companies

| Operation | Method | Endpoint                                             |
| --------- | ------ | ---------------------------------------------------- |
| List      | GET    | `/api/v2/admin-settings/organization-companies`      |
| Add       | POST   | `/api/v2/admin-settings/organization-companies`      |
| Delete    | DELETE | `/api/v2/admin-settings/organization-companies/{id}` |

---

### Workflow

> Min build: **7040**

---

#### Create Workflow Request

```
POST /api/v1/workflow/raiseRequest
```

Raise a workflow request for any supported AD operation that requires approval.

**Request Body:**

| Field         | Type   | Required | Description                                         |
| ------------- | ------ | -------- | --------------------------------------------------- |
| `domainName`  | string | Yes      | Target AD domain                                    |
| `requestType` | string | Yes      | Type of workflow (e.g., `createUser`, `deleteUser`) |
| `requestedBy` | string | Yes      | Technician submitting the request                   |
| `parameters`  | object | Yes      | Operation-specific parameters                       |
| `comments`    | string | No       | Justification or notes                              |

---

## Error Codes

When the API returns a `4xx` or `5xx` response, the body includes a JSON error object:

```json
{
  "errorCode": "ADM-4001",
  "message": "User not found in the specified domain.",
  "details": "No account matching 'jdoe' was found in corp.example.com"
}
```

| Code Range | Category                                           |
| ---------- | -------------------------------------------------- |
| 4xx        | Client errors (bad input, auth failure, not found) |
| 5xx        | Server errors (unexpected failures)                |

Full error code reference: https://www.manageengine.com/products/ad-manager/active-directory-api/v2/errors/#error-codes

---

## Endpoint Quick Reference

| Category           | Operation             | Method          | Min Build |
| ------------------ | --------------------- | --------------- | --------- |
| **Users**          | List/Search           | GET             | 6583      |
|                    | Create                | POST            | 6583      |
|                    | Update Attributes     | PATCH           | 7040      |
|                    | Delete                | POST            | 6583      |
|                    | Disable               | POST            | 6583      |
|                    | Enable                | POST            | 6583      |
|                    | Reset Password        | POST            | 6583      |
|                    | Unlock                | POST            | 6583      |
|                    | Move                  | POST            | 7200      |
|                    | Add to Groups         | POST            | 7040      |
|                    | Remove from Groups    | POST            | 7040      |
| **Groups**         | List/Search           | GET             | 7180      |
|                    | List Members          | GET             | 7180      |
|                    | Create                | POST            | 7180      |
|                    | Update                | PATCH           | 8030      |
|                    | Delete                | POST            | 7180      |
|                    | Move                  | POST            | 7180      |
| **Computers**      | List/Search           | GET             | 7200      |
|                    | Create                | POST            | 8030      |
|                    | Update                | PATCH           | 8030      |
|                    | Disable               | PATCH           | 7200      |
|                    | Enable                | POST            | 7200      |
|                    | Delete                | POST            | 7200      |
|                    | Move                  | POST            | 7200      |
|                    | Add to Groups         | POST            | 7200      |
|                    | Remove from Groups    | POST            | 7200      |
| **Contacts**       | List                  | GET             | 8030      |
|                    | Create                | POST            | 8030      |
|                    | Update                | PATCH           | 8030      |
|                    | Delete                | DELETE          | 8030      |
| **OUs**            | List                  | GET             | 7200      |
|                    | Create                | POST            | 7010      |
|                    | Update                | PATCH           | 8030      |
|                    | Delete                | POST            | 7200      |
| **Domains**        | List                  | GET             | 7180      |
|                    | Update Settings       | POST            | 7040      |
| **AuthToken**      | Remove                | POST            | 7200      |
| **Orchestration**  | List Templates        | GET             | 8030      |
|                    | Execute               | POST            | 8030      |
|                    | Get Status            | GET             | 8030      |
| **Admin Settings** | Env Variables (CRUD)  | GET/POST/PATCH  | 8030      |
|                    | Org Titles (CRD)      | GET/POST/DELETE | 8030      |
|                    | Org Departments (CRD) | GET/POST/DELETE | 8030      |
|                    | Org Offices (CRD)     | GET/POST/DELETE | 8030      |
|                    | Org Companies (CRD)   | GET/POST/DELETE | 8030      |
| **Workflow**       | Create Request        | POST            | 7040      |
