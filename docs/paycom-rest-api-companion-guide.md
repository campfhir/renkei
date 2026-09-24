# Paycom REST API — Companion Guide

> Source: "Paycom API Companion Guide" (Version 4.0), converted from the
> vendor PDF (`Paycom - REST API Companion Guide V3.1`, internally
> versioned 4.0 in the document itself).
> Reference only — no Paycom connector exists in this codebase yet. This
> is dropped in for whoever builds one. See also
> [`paycom-webhooks.md`](./paycom-webhooks.md).

## Endpoint Groups

### Employee Endpoints Group

**Employee Lists**

| Route | Description |
| --- | --- |
| `api/v1/employeeid` | Return a list of employee identifiers. |
| `api/v1/employeedirectory` | Return a paginated list of employees and their demographics. |
| `api/v1/employeenewhire` | Return a list of employees added in a specific date range. |

**Non-Sensitive Employee Information**

| Route | Description |
| --- | --- |
| `api/v1/employee/:eecode` | Return an employee master record. |
| `api/v1/employee/:eecode/customfield` | Return custom field information for an employee. |
| `api/v1.1/employee/:eecode/change` | Return an audit log of updates made to non-sensitive employee fields for a specified date range. |
| `api/v1/employee/:eecode/photo` | Return an encoded string representing the employee photo. |
| `api/v1/employee/:eecode/tax` | Return employee tax setup from Form 1. |
| `api/v1/employee/:eecode/ratesbyallocation` | Return employee rates by allocation information from Form 10. |

**Sensitive Employee Information**

| Route | Description |
| --- | --- |
| `api/v1/employee/:eecode/sensitive` | Return an employee master record along with sensitive data. |
| `api/v1.1/employee/:eecode/sensitivechange` | Return an audit log of updates made to employee fields (including sensitive changes) for a specified date range. |

### Time and Attendance Endpoint Group

| Route | Description |
| --- | --- |
| `api/v1.1/punchimport` | Add, edit, or delete time clock events on employee time cards. |
| `api/v1/employee/:eecode/punchaudit` | Return historical information about punches for a specified date range. |
| `api/v1/employee/:eecode/punchhistory` | Return a list of employee punches. |

### New Hire Endpoint Group

| Route | Description |
| --- | --- |
| `api/v1/newhireids` | Return a list of IDs of New Hires within a given time range. |
| `api/v1/newhire/:new-hire-id` | Return the New Hire information for the given new hire id. |
| `api/v1/newhire/:new-hire-id/customfield` | Return custom field information for new hires. |
| `api/v1/newhire/:new-hire-id/photo` | Return an encoded string representing the new hire photo. |

### Position Management Endpoint Group

| Route | Description |
| --- | --- |
| `api/v1/positions/detail` | List all position codes, or fetch details for one via a parameter. |
| `api/v1/positions/levels` | List all position level codes, or fetch details for one via a parameter. |
| `api/v1/positions/seats` | List all position seat numbers, or fetch details for one via a parameter. |

### Client Endpoint Group

**Locations and Establishments**

| Route | Description |
| --- | --- |
| `api/v1/cl/locations` | Return all, or specific, Company Locations configured for the client. |
| `api/v1/cl/establishments` | Return all, or specific, Company Establishments configured for the client. |

**Labor Allocations**

| Route | Description |
| --- | --- |
| `api/v1/cl/category` | Return all labor allocation categories, or one if specified. |
| `api/v1/cl/category/:catcode/detail` | Return information for one or all distributions in a labor allocation category. Also used to add new distributions or update existing ones (PUT/PATCH). |

**Misc**

| Route | Description |
| --- | --- |
| `api/v1/cl/earning` | Return information about earnings. |

## Notes and Things to Consider

- Use a testing tool such as Postman for your first connection to the
  Paycom API, to manually step through requests/responses before writing
  code.
- Some methods have access limitations — timeouts between subsequent
  calls, or a cap on calls per 24-hour period. An error response
  indicates when a limitation is hit.
- Questions/problems: contact the Implementation API Team.

## How to Connect

You receive an **SID** and **Token** from your Paycom representative.
Before receiving them, you provide the initial WAN IP address(es) that
will be used to connect — these are attached to the SID to create a
secure connection.

- Base URL: `https://api.paycomonline.net/v4/rest/index.php`
- Auth: HTTP Basic auth header, where the SID is the username and the
  Token is the password, base64-encoded as `sid:token`.
- After initial setup, Client Admins maintain API users (endpoint
  permissions, IP allow-listing) at **User Options → User Access and
  Security → API Setup** inside Paycom.

```
curl -X GET \
  https://api.paycomonline.net/v4/rest/index.php/api/v1/employeeid \
  -H 'Authorization: Basic **Base64 encoded sid:token here**' \
  -H 'Cache-Control: no-cache' \
  -H 'Content-Type: application/json'
```

## Retrieve Paginated Results

A full "all employees" pull will likely come back as a partial result
(**HTTP 206 Partial Content**) due to pagination. Two ways to get
everything:

1. **Increase page size** via the `pagesize` parameter:

   ```
   https://api.paycomonline.net/v4/rest/index.php/api/v1/employeedirectory?pagesize=500
   ```

   Response headers `X-Max-Page-Size` (max allowed page size) and
   `X-Total-Count` (total record count) are useful here.

2. **Follow the `Link` header**, which carries relative URLs for
   `prev`/`first`/`last` (and implicitly `next`) pages:

   ```
   'Link': '<...employeedirectory?requestid=...&page=2>; rel="prev",
            <...employeedirectory?requestid=...&page=1>; rel="first",
            <...employeedirectory?requestid=...&page=3>; rel="last",'
   ```

## API Sample Workflow

### Retrieve List of Employees

```
GET https://api.paycomonline.net/v4/rest/index.php/api/v1/employeedirectory/
```

```json
{
  "result": true,
  "data": [
    {
      "eecode": "A001",
      "eename": "GREEN, ALEX",
      "firstname": "ALEX",
      "lastname": "GREEN",
      "gender": "1",
      "streetaddr": "4327 MAIN STREET",
      "cityaddr": "FT WORTH",
      "clockseq": "8765432",
      "eebadge": "140831",
      "zipcode": "55555",
      "homestate": "TX",
      "homephone": "",
      "eestatus": "A",
      "deptcode": "99900",
      "deptdesc": "heather test",
      "cat1": "1",
      "cat1desc": "1",
      "cat2": "CanbeAlpha1",
      "cat2desc": "state4",
      "cat3": "003",
      "cat3desc": "NewCode"
    }
  ],
  "errors": [],
  "errorCount": 0,
  "records": 1
}
```

### Retrieve Employee Changes

```
GET https://api.paycomonline.net/v4/rest/index.php/api/v1/employee/A002/change/
```

Add a date range with query parameters:

```
GET .../api/v1/employee/A002/change?startdate=UNIXTimeStamp&enddate=UNIXTimeStamp
```

`eecode` is mandatory (it's a path parameter). Sample response:

```json
{
  "result": true,
  "data": [
    {
      "changedby": "hhtest",
      "changedesc": "Position Mgmt: Position Seat",
      "changetime": "2019-12-02T10:19:21-06:00",
      "changetype": "U",
      "childcode": "",
      "clockseq": "8765432",
      "eecode": "A001",
      "eename": "GREEN, ALEX",
      "new_value": "Sales Representative-3",
      "notes": "",
      "old_value": "CEO",
      "usetype": 1
    },
    {
      "changedby": "hhtest",
      "changedesc": "Position Mgmt: Position Family",
      "changetime": "2019-12-02T10:19:21-06:00",
      "changetype": "U",
      "childcode": "",
      "clockseq": "8765432",
      "eecode": "A001",
      "eename": "GREEN, ALEX",
      "new_value": "9128",
      "notes": "",
      "old_value": "9293",
      "usetype": 1
    }
  ],
  "errors": [],
  "errorCount": 0,
  "records": 8
}
```

### Import Labor Allocation Codes

```
PUT/PATCH https://api.paycomonline.net/v4/rest/index.php/api/v1/cl/category/:catcode/detail
```

Example: import a new "Waiter" job (code `1234`) into labor allocation
category 2 (`Job`):

**PUT** `.../api/v1/cl/category/2/detail`

```json
{
  "hideonline": 0,
  "detailcode": "1234",
  "detaildesc": "Waiter",
  "glcode": "1234"
}
```

**PATCH** (update the description of the existing detail code) `.../api/v1/cl/category/2/detail/1234`

```json
{
  "hideonline": 0,
  "detailcode": "1234",
  "detaildesc": "Waiter OLD",
  "glcode": "1234"
}
```

### Import Time

```
POST https://api.paycomonline.net/v4/rest/index.php/api/v1.1/punchimport
```

Example: employee `A001` punches in/out for the day; employee `B001`
records 5 hours of Regular time and $30 of tips.

```json
[
  { "eecode": "A001", "deptcode": "1234", "entrytype": 1, "punchtime": "1591016400", "punchtype": "ID", "timezone": "CST" },
  { "eecode": "A001", "entrytype": 1, "punchtime": "1591048800", "punchtype": "OD", "timezone": "CST" },
  { "eecode": "B001", "entrytype": 2, "hours": 5.0, "earncode": "R", "punchtime": "1590987600", "timezone": "CST" },
  { "eecode": "B001", "entrytype": 3, "dollaramount": 30, "earncode": "TP1", "punchtime": "1590987600", "timezone": "CST" }
]
```

Notes:

- Earning Code, Labor Allocation, and Department values are unique per
  client — confirm with your Paycom Specialist.
- Best practice: only send the fields required to allocate the time
  event.
- The v1.1 punch import response includes a Paycom-assigned `punchId` per
  punch item — store it for mapping/troubleshooting. Also track whether
  each punch was successfully sent: if the request fails, **all** punches
  in that request are considered failed and not written to the timecard;
  the whole batch must be revised and resent.

```json
{
  "result": true,
  "data": [
    { "punchId": 75323044, "makeUpTime": false, "externalId": null }
  ],
  "errors": [],
  "errorCount": 0,
  "records": 1
}
```

## Error Handling

Every response includes a `result` field: `false` if the call itself
failed, `true` if it succeeded. Check the endpoint-specific documentation
for the response codes a given endpoint can return.

- `200` on GET, `201` on PUT/POST indicates success.

## Maintaining API Users

1. In **Permission Profiles**, grant your IT personnel's profile access
   to the API Setup screen (API tab → check "API Setup"), and decide
   whether those users can create/edit permissions or access sensitive
   functions. If this option isn't visible, contact your dedicated
   specialist.
2. Navigate to **User Access and Security → API Setup** to see each API
   user's details. New API users are added by your Paycom specialist on
   request.
3. Click the pencil icon under **Edit** to edit an API user: point of
   contact name, description, email, and which functions (checkboxes)
   that user can access. Sensitive functions only show up if "Access to
   Sensitive Functions" is enabled in Permission Profiles. A new token
   can also be generated from this screen. Click **Update** when done.
4. Click **Documentation** on the API Setup screen to view Client,
   Employee, New Hire, Position Management, and Time and Attendance
   documentation by tab; expand a section and click **GET** for details
   on a specific route. **Export to PDF** exports all of it.

## Support

The Technical Solutions Team can help with API issues/questions:
`automation@paycomonline.com`. Include your client code or company name
and as much detail as possible.
