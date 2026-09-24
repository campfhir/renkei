# Paycom Webhooks

> Source: Paycom "Webhooks Documentation" (2024.01 v2), converted from the vendor PDF.
> Reference only — no Paycom connector exists in this codebase yet. This
> is dropped in for whoever builds one.

## Introduction

Paycom's webhooks are like a reverse API that Paycom fires any time a
certain event occurs. Event information (e.g. an employee status change)
is transmitted directly to a third-party application or middleware
outside of Paycom right after it happens. The webhook payload contains
details about the event; the receiving party then makes an API call to
get the full details. This lets clients avoid constantly polling the API,
greatly reducing the number of API requests needed.

**Example:** A client with 500 employees wants to detect employee
changes. Without webhooks, polling every 15 minutes costs `500 × 4 × 24 =
48,000` calls/day to catch maybe 100 real changes. With webhooks, that
drops to the ~100 calls that actually correspond to changes.

## Available Event Notifications

- New Hire Created
- New Hire Deleted
- New Hire Self Onboarding Completed
- Employee Added
- Employee Photo Added
- Employee Change (see the long list of subscribable fields below)
- Subscribed / Unsubscribed / Verification URL / Ping (meta-events, see table below)

### Available Employee Change Events

Any of these fields can be individually subscribed to under the
"Employee Change" event:

Additional Schedule Group, Alternate Pay Frequency, Available Health
Insurance, Badge Level, Badge Number, Birth Date, Clock Sequence Number,
Cobra End, Cobra Start, Commission Only, Current Key Employee, DOL
Status, EE Message, EEOC Class, Eligible 401K, Email Change, Emergency
Contact Information, Employee Address Changes, Employee Department
Changes, Employee GL Code, Employee Labor Allocation Changes, Employee
Location Changes, Employee Name Changes, Employee Phone Changes,
Employee Position Change, Employee Re-Hire, Employee Status, Ethnic
Background, Exempt Status, Full Time to Part Time Date, Gender, Highly
Comp Employee, Hire Date, Hourly Or Salary, Hours 401K, Last Pay Change,
Last Position Change Date, Last Review, Marital Status, Match Eligible,
Next Review, Non Resident Alien, On-Leave Start and End Date, Part Num
401K, Part Time To Full Time Date, Pay Class, Pay Frequency, Position
Family, Position Level Change, Position Seat Change, Position Title
Change, Previous Termination Date, Primary Schedule Group, Retirement
Plan, Schedule Time Zone, Statutory Employee, Supervisor Learning,
Supervisor Primary, Supervisor Quaternary, Supervisor Secondary,
Supervisor Talent, Supervisor Tertiary, Supervisor Time-Off Approval,
Terminal Access Group, Termination Date, Termination Reason, Union Code,
Vets 4212 Emp Category, Vets 4212 Job Category, Workers Comp Code.

## Requirements

- Familiarity with the Paycom API — webhooks are an extension of it.
  A webhook notification only tells you *something* changed; you make a
  follow-up API call to retrieve the detailed information.
- A webhook endpoint (a web server able to accept requests from Paycom —
  .NET, PHP, or similar).
- Receive the message, validate it's from Paycom, insert it into a job
  queue, and promptly respond — don't do the real processing inline.
- **HTTPS required.** Paycom validates the endpoint is secure before
  sending webhook data; the server needs a valid certificate.
- **2xx required.** Paycom expects a 2xx status after posting the
  payload. No response, a timeout, or a non-2xx status triggers a resend
  after 60 seconds, defaulting to 10 retries (configurable per webhook).

## Configuration and Setup

The webhook configuration page lives in the **API Setup** menu of
Paycom's client portal (requires client user access with the right
permission profile). There you set the endpoint URL, custom headers, and
which events generate webhooks. A transmission log shows past events.

The key configuration item is a **custom header carrying a secret-key
JSON value** — the mechanism to validate an incoming webhook actually
came from Paycom. More values can be included, and the custom header can
be set per subscribed event.

Example resulting header:

```json
{
  "Content-Type": "application/json",
  "Content-Length": "311",
  "Secret-Key": "123",
  "User-Agent": "GuzzleHttp/6.5.3 curl/7.55.0 PHP/7.1.10",
  "Host": "intranet2.paycomhq.com"
}
```

## Possible Webhooks

| Event | Description | Use | Next Step |
| --- | --- | --- | --- |
| Subscribed | Notifies you a new subscription was set up. | Notification of new event subscription | None — notification only |
| Verification URL | Sent when verifying a new webhook setup; carries an authorization code that must be entered into Paycom to finalize setup. Failure to enter it prevents further notifications. Once a URL is validated, no further validation is required. | Validate a new webhook URL | Use the registration code to verify the webhook URL |
| Ping | Manually triggered from the Paycom Webhook Interface, for testing. | Test a webhook URL | None — notification only |
| New Hire Created | Fired when a new hire is created (New Employee Queue). | Know when a new hire is added | API call to get new hire information |
| New Hire Deleted | Fired when a new hire is archived (New Employee Queue). | Know when a new hire is archived | Stop any process concerning that new hire in other systems |
| New Hire Self Onboarding Completed | Fired when new-hire self-onboarding (entering personal info) completes. | Know self-onboarding finished | API call to get new hire information |
| Employee Added | Fired when an employee is added — via import, manual add, or new-hire → employee conversion. | Know a new hire converted / an employee was added manually; most HR workflows need IT resources allocated at this point | API call to get employee information; trigger IT onboarding (create accounts, service-desk tickets for equipment, etc.) |
| Employee Photo Added | Fired when an employee's photo is updated. | Know a photo was updated | API call to retrieve the photo and update other systems (e.g. Active Directory) |
| Employee Change | Fired for any selected subscribed employee change; includes a direct API link (callback URL) to the change. | Know some employee information changed | API call to retrieve the change and update other systems |
| Unsubscribed | Notifies you a subscription was deleted in the Webhook Configuration menu. | Know an event subscription was removed | Consider alerting if this wasn't intentional |

## Common Payload Fields

| Field | Description |
| --- | --- |
| `Event_ID` | Unique ID of the webhook event. Process each ID only once — duplicate deliveries can happen. |
| `Event_Name` | Friendly description of the event. |
| `Event_DateTime` | UTC time of the event (Unix timestamp). |
| `ClientCode` | Client code the event pertains to — useful when listening across multiple Paycom client instances. |
| `Resource` / `Resource_Identifier` / `Object` / `Object_Identifier` | Identify what the event is about. |
| `Data` | Varies per webhook; see examples below. |
| `Endpoint` | Recommended API endpoint to use to gather more information. |
| `EndpointUrl` | Direct API link to the data (relative — does not include the base API URL). |

## Example Payloads

Only a representative sample is included here (per the vendor doc).

**Subscribed**

```json
{
  "Event_Id": "933846ac57b707daa7616239dc6d248d",
  "Event_Name": "Subscribed",
  "Event_DateTime": 1605907265,
  "ClientCode": "05510",
  "Resource_Field": null,
  "Resource_Identifier": null,
  "Object": null,
  "Object_Identifier": null,
  "Data": { "Event_URL": 15, "Subscribed_Event": "new_hire_created" },
  "Endpoint": "",
  "EndpointUrl": ""
}
```

**Verification URL**

```json
{
  "Event_Id": "72e5f632c3e86fe77d63124743969a8e",
  "Event_Name": "Verify URL",
  "Event_DateTime": 1605910379,
  "ClientCode": "05510",
  "Resource_Field": null,
  "Resource_Identifier": null,
  "Object": null,
  "Object_Identifier": null,
  "Data": {
    "verification_code": "318873",
    "expires_on": {
      "date": "2020-11-21 16:12:59.000000",
      "timezone_type": 3,
      "timezone": "America/Chicago"
    }
  },
  "Endpoint": "",
  "EndpointUrl": ""
}
```

**Ping**

```json
{
  "Event_Id": "d76adfae03b156698f9035cd88f8c4a9",
  "Event_Name": "Ping",
  "Event_DateTime": 1605910510,
  "ClientCode": "05510",
  "Resource_Field": null,
  "Resource_Identifier": null,
  "Object": null,
  "Object_Identifier": null,
  "Data": null,
  "Endpoint": "",
  "EndpointUrl": ""
}
```

**New Hire Created**

```json
{
  "Event_Id": "ed9db3bf1640c8b6b1c99922ac6056f1",
  "Event_Name": "New Hire Created",
  "Event_DateTime": 1605926665,
  "ClientCode": "05510",
  "Resource_Field": "New Hire",
  "Resource_Identifier": null,
  "Object": null,
  "Object_Identifier": 75067,
  "Data": null,
  "Endpoint": "New Hire",
  "EndpointUrl": "api/v1/newhire/75067"
}
```

**New Hire Deleted**

```json
{
  "Event_Id": "5b2b2db73ec375e806900f6a081e8bf5",
  "Event_Name": "New Hire Deleted",
  "Event_DateTime": 1605926747,
  "ClientCode": "05510",
  "Resource_Field": "New Hire",
  "Resource_Identifier": null,
  "Object": null,
  "Object_Identifier": 75067,
  "Data": null,
  "Endpoint": "New Hire",
  "EndpointUrl": "api/v1/newhire/75067"
}
```

**New Hire Self Onboarding Completed**

```json
{
  "Event_Id": "34192b9a4b024c7e1415dcf479dcd869",
  "Event_Name": "New Hire Self Onboarding Completed",
  "Event_DateTime": 1605927634,
  "ClientCode": "05510",
  "Resource_Field": "Employee OnBoarding",
  "Resource_Identifier": null,
  "Object": null,
  "Object_Identifier": 75070,
  "Data": { "Employee_ID": "Null" },
  "Endpoint": "New Hire",
  "EndpointUrl": "api/v1/newhire/75070"
}
```

**Employee Added**

```json
{
  "Event_Id": "8e8e39a7e505d3f771ee97192af54a8b",
  "Event_Name": "Employee Created",
  "Event_DateTime": 1606750722,
  "ClientCode": "05510",
  "Resource_Field": "Employee",
  "Resource_Identifier": null,
  "Object": null,
  "Object_Identifier": "A00Y",
  "Data": { "Employee_ID": "A00Y", "Is_Rehire": "N", "Was_New_Hire": "Y" },
  "Endpoint": "Employee",
  "EndpointUrl": "api/v1/employee/A00Y"
}
```

**Employee Photo Added**

```json
{
  "Event_Id": "764da13267e76c8e9254144622b1cb0d",
  "Event_Name": "Employee Photo Added",
  "Event_DateTime": 1605930665,
  "ClientCode": "05510",
  "Resource_Field": "Employee Photo",
  "Resource_Identifier": null,
  "Object": "Employee",
  "Object_Identifier": "A00X",
  "Data": null,
  "Endpoint": "Employee Photo",
  "EndpointUrl": "api/v1/employee/A00X/photo"
}
```

**Employee Change (address change)**

```json
{
  "Event_Id": "19c30616a070fd1fd2915d1b92d065a9",
  "Event_Name": "Employee Changes",
  "Event_DateTime": 1605929535,
  "ClientCode": "05510",
  "Resource_Field": "Employee Address Changes",
  "Resource_Identifier": null,
  "Object": "Employee",
  "Object_Identifier": "A00X",
  "Data": null,
  "Endpoint": "Employee Changes",
  "EndpointUrl": "api/v1.1/employee/A00X/change/463q63vzql4"
}
```

**Employee Change (name change)**

```json
{
  "Event_Id": "e5475748d21083a574d7c3d50924fd8e",
  "Event_Name": "Employee Changes",
  "Event_DateTime": 1605929681,
  "ClientCode": "05510",
  "Resource_Field": "Employee Name Changes",
  "Resource_Identifier": null,
  "Object": "Employee",
  "Object_Identifier": "A00X",
  "Data": null,
  "Endpoint": "Employee Changes",
  "EndpointUrl": "api/v1.1/employee/A00X/change/463q63vq3z4"
}
```

**Unsubscribed**

```json
{
  "Event_Id": "56f325d8184aaa574f19c69158420f7c",
  "Event_Name": "UnSubscribed",
  "Event_DateTime": 1605907191,
  "ClientCode": "05510",
  "Resource_Field": null,
  "Resource_Identifier": null,
  "Object": null,
  "Object_Identifier": null,
  "Data": { "Event_URL": 15 },
  "Endpoint": "",
  "EndpointUrl": ""
}
```

## Best Practices

- Respond as soon as possible after receipt; do the real processing in a
  separate process or job queue.
- Endpoints might receive the same event more than once — make
  processing idempotent (log processed `Event_Id`s, skip already-logged
  ones).
- Paycom does not guarantee delivery order. Don't assume events arrive in
  the order they were generated.
- Set up a daily full-sync process in case any changes were missed — also
  useful for initial sync or a manually triggered sync.

## Sample Webhook Receiver (PHP, illustrative only)

Not production-ready — provided by Paycom purely to illustrate the
workflow: extract the secret-key header, reject with 401 if it doesn't
match, persist header + body to a queue/log, and return 200.

```php
<?php
// 1. Extract headers to pull out secret key
// 2. Verify secret key, return 401 if not authorized
// 3. Convert headers and body to JSON
// 4. Save header and body to database and log file (a separate process
//    consumes the queue so the listener isn't blocked on real processing)
// 5. Return 200 to acknowledge receipt

$dbhost = 'localhost';
$dbname = 'webhooks';
$dbusername = 'webhooks';
$dbpassword = '...';

$headers = apache_request_headers();

if (isset($headers['Secret-Key']) == false || $headers['Secret-Key'] != '123') {
    echo "Not Authorized";
    http_response_code(401);
    header("HTTP/1.1 401 Unauthorized");
    exit;
}

$json_header = json_encode($headers);

if ($json = json_decode(file_get_contents("php://input"), true)) {
    $json_body = json_encode($json);
} else {
    $myfile = fopen("errors.log", "a") or die("Unable to open file!");
    fwrite($myfile, "\nError with message. Invalid JSON. Input:" . "\n" . file_get_contents("php://input"));
    fclose($myfile);
    exit;
}

try {
    $conn = new PDO("mysql:host=$dbhost;dbname=$dbname", $dbusername, $dbpassword);
    $conn->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $cmd = $conn->prepare("INSERT INTO events (header, body, time_received) VALUES (?,?,?)");
    $cmd->execute(array($json_header, $json_body, date("Y-m-d H:i:s")));
} catch (PDOException $ex) {
    $myfile = fopen("errors.log", "a") or die("Unable to open file!");
    fwrite($myfile, "\n" . $ex->getMessage());
    fclose($myfile);
}

http_response_code(200);
header("HTTP/1.1 200 OK");
?>
```
