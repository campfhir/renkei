# API Search and Response Columns

ADManager Plus APIs allow administrators to retrieve and filter Active Directory (AD) data with precision. Each API endpoint, such as users, groups, computers, contacts, and organizational units supports a set of columns that define what can be searched and what can be returned in the API response.

- Search columns: Attributes that can be used as filters in API queries to narrow down results.
- Response columns: Attributes that can be included in the API response payload.

Understanding these columns ensures you can build optimized API requests, return only the attributes needed, and improve performance when integrating ADManager Plus with other applications or scripts.

Below is the complete list of supported search and response columns, mapped with their LDAP attributes and a description of each.

> Note: Always use the Column Name (not the LDAP name) when specifying attributes in the filter, sort, and fields parameters of an API request.
> With search object APIs , such as Search User, Search Group, Search Computer, Search Contact, and Search OU , the attributes that are returned in the response or that are available for filtering depend on what is enabled under Response Columns and Search Columns. To configure these, go to Admin > System Settings > Integrations > Rest API and click the gear icon next to the respective API.

REST API response and search column configuration pop-up in ADManager Plus.

Pop-up for configuring response and search columns in the REST API settings.

## Users API

This API supports a wide range of user attributes that can be searched or retrieved as part of the response. These columns help administrators filter users effectively and return only the required details during queries.

> Note: Always use the Column Name (not the LDAP name) when specifying attributes in the filter, sort, and fields parameters of an API request.

| Attribute LDAP name        | Column name                      | Search | Response | Description                                                      |
| -------------------------- | -------------------------------- | ------ | -------- | ---------------------------------------------------------------- |
| userAccountControl         | ACCOUNT_STATUS                   | No     | Yes      | Indicates the current account status (enabled, disabled, locked) |
| accountExpires             | ACCOUNT_EXPIRY_DATE              | No     | Yes      | The date when the user account is set to expire                  |
| company                    | COMPANY                          | Yes    | Yes      | The company name associated with the user account                |
| co                         | COUNTRY                          | Yes    | Yes      | Country or region assigned to the user account                   |
| department                 | DEPARTMENT                       | Yes    | Yes      | Department to which the user account belongs                     |
| displayName                | DISPLAY_NAME                     | Yes    | Yes      | Full display name of the user account                            |
| employeeID                 | EMPLOYEE_ID                      | Yes    | Yes      | Unique employee ID for the user account                          |
| facsimileTelephoneNumber   | FAX                              | Yes    | Yes      | User account's fax number                                        |
| givenName                  | FIRST_NAME                       | Yes    | Yes      | User account’s first name                                        |
| homeDirectory              | HOME_DIRECTORY                   | No     | Yes      | Path to the user account’s home directory                        |
| homePhone                  | HOME_PHONE                       | Yes    | Yes      | User account’s home phone number                                 |
| info                       | NOTES                            | Yes    | Yes      | Additional notes about the user account                          |
| initials                   | INITIAL                          | Yes    | Yes      | User account’s initials                                          |
| ipPhone                    | IP_PHONE                         | Yes    | Yes      | IP phone number for the user account                             |
| l                          | CITY                             | Yes    | Yes      | City associated with the user account                            |
| mail                       | EMAIL_ADDRESS                    | Yes    | Yes      | User account’s email address                                     |
| mobile                     | MOBILE                           | Yes    | Yes      | Mobile number of the user account                                |
| name                       | FULL_NAME                        | Yes    | Yes      | Full name of the user account                                    |
| pager                      | PAGER                            | Yes    | Yes      | Pager number assigned to the user account                        |
| postalCode                 | ZIP_POSTAL_CODE                  | Yes    | Yes      | Zip or postal code of the user account’s location                |
| profilePath                | PROFILE_PATH                     | Yes    | Yes      | Path to the user account’s profile                               |
| sAMAccountName             | SAM_ACCOUNT_NAME                 | Yes    | Yes      | Pre-Windows 2000 logon name of the user account                  |
| scriptPath                 | SCRIPT_PATH                      | Yes    | Yes      | Path to the logon script for the user account                    |
| sn                         | LAST_NAME                        | Yes    | Yes      | User account’s last name (surname)                               |
| streetAddress              | STREET_ADDRESS                   | Yes    | Yes      | Street address of the user account                               |
| st                         | STATE_PROVINCE                   | Yes    | Yes      | State or province of the user account’s location                 |
| telephoneNumber            | TELEPHONE_NUMBER                 | Yes    | Yes      | Primary telephone number of the user account                     |
| title                      | TITLE                            | Yes    | Yes      | Job title or designation of the user account                     |
| userPrincipalName          | LOGON_NAME                       | Yes    | Yes      | User account's logon name (UPN format)                           |
| wWWHomePage                | WEB_PAGE                         | Yes    | Yes      | User account’s personal or work web page                         |
| description                | DESCRIPTION                      | Yes    | Yes      | Description or notes field for the user account                  |
| physicalDeliveryOfficeName | OFFICE                           | Yes    | Yes      | User account’s office location                                   |
| cn                         | COMMON_NAME                      | Yes    | Yes      | Common name (CN) of the user account                             |
| canonicalName              | CANONICAL_NAME                   | Yes    | Yes      | Canonical name path of the user account                          |
| employeeNumber             | EMPLOYEE_NUMBER                  | Yes    | Yes      | Employee number of the user account (different from employee ID) |
| domainName                 | DOMAIN_NAME                      | No     | Yes      | Domain in which the user account resides                         |
| memberOf                   | MEMBER_OF                        | No     | Yes      | Groups of which the user account is a member                     |
| primaryGroupID             | PRIMARY_GROUP_ID                 | No     | Yes      | Primary group ID assigned to the user account                    |
| objectSID                  | SID_STRING                       | No     | Yes      | Security identifier (SID) of the user account                    |
| objectGUID                 | OBJECT_GUID                      | No     | Yes      | Globally unique identifier (GUID) of the user account            |
| distinguishedName          | DISTINGUISHED_NAME               | No     | Yes      | Distinguished name (DN) of the user account in AD                |
| whenChanged                | WHEN_CHANGED                     | No     | Yes      | Last modified date and time of the user account                  |
| whenCreated                | WHEN_CREATED                     | No     | Yes      | Creation date and time of the user account                       |
| msDS-PSOApplied            | PSO_APPLIED                      | No     | Yes      | Password settings object (PSO) applied to the user account       |
| msDS-ResultantPSO          | PSO_RESULTANT                    | No     | Yes      | Effective PSO applied to the user account                        |
| pwdLastSet                 | PASSWORD_STATUS                  | No     | Yes      | Indicates password status (set or expired)                       |
| pwdLastSet                 | PASSWORD_LAST_SET                | No     | Yes      | Timestamp of when the password was last set                      |
| pwdLastSet                 | PASSWORD_EXPIRY_DATE             | No     | Yes      | Date on which the password will expire                           |
| lastLogon                  | LAST_LOGON_TIME                  | No     | Yes      | Timestamp of the last logon                                      |
| lastLogon                  | DAYS_SINCE_LAST_LOGON            | No     | Yes      | Number of days since last logon                                  |
| pwdLastSet                 | DAYS_TO_EXPIRE_PASSWORD          | No     | Yes      | Number of days left before the password expires                  |
| badPasswordTime            | BAD_PASSWORD_TIME                | No     | Yes      | Last time an incorrect password was attempted                    |
| badPwdCount                | BAD_PASSWORD_COUNT               | No     | Yes      | Number of failed logon attempts                                  |
| logonCount                 | LOGON_COUNT                      | No     | Yes      | Number of successful logons                                      |
| userWorkstations           | LOGON_TO                         | No     | Yes      | Workstations from which the user account can log on              |
| lockoutTime                | LOCK_OUT_TIME                    | No     | Yes      | Time when the user account was locked out                        |
| pwdLastSet                 | DAYS_SINCE_PASSWORD_SET          | No     | Yes      | Number of days since the password was last set                   |
| userAccountControl         | PWD_NEV_EXP_FLAG                 | No     | Yes      | Indicates if the password is set to never expire                 |
| lastLogonTimestamp         | LAST_LOGON_TIMESTAMP             | No     | Yes      | Replicated last logon timestamp                                  |
| userAccountControl         | SMART_CARD_FOR_INTERACTIVE_LOGIN | No     | Yes      | Indicates if a smart card is required for login                  |
| userAccountControl         | USER_ACCOUNT_CONTROL             | No     | Yes      | User account control attributes                                  |
| userAccountControl         | USER_ACCOUNT_CONTROL_FLAG        | No     | Yes      | Detailed user account control flags                              |
| logonHours                 | LOGON_HOURS                      | No     | Yes      | Logon hours permitted for the user account                       |
| manager                    | MANAGER                          | No     | Yes      | User account’s manager in the directory                          |
| OUName                     | OU_NAME                          | Yes    | Yes      | OU of the user account                                           |
| postOfficeBox              | P_O_BOX                          | Yes    | Yes      | Post office box of the user account                              |

## Groups API

This API supports a range of group attributes that can be used to filter results or return specific details about AD groups. These columns help administrators identify group properties, memberships, scope, and management information during queries.

> Note: Always use the Column Name (not the LDAP name) when specifying attributes in the filter, sort, and fields parameters of an API request.

| Attribute LDAP name             | Column name        | Search | Response | Description                                                   |
| ------------------------------- | ------------------ | ------ | -------- | ------------------------------------------------------------- |
| description                     | DESCRIPTION        | Yes    | Yes      | Text description of the group’s purpose or role               |
| mail                            | EMAIL_ADDRESS      | Yes    | Yes      | Primary email address of the group                            |
| managedBy                       | MANAGER            | No     | Yes      | User or group configured as the manager or owner of the group |
| name                            | FULL_NAME          | No     | Yes      | Full name of the group object                                 |
| groupType                       | GROUP_TYPE         | No     | Yes      | Type of group (e.g., security or distribution)                |
| info                            | NOTES              | Yes    | Yes      | Additional notes or information about the group               |
| sAMAccountName                  | SAM_ACCOUNT_NAME   | Yes    | Yes      | Pre-Windows 2000 logon name of the group                      |
| cn                              | GROUP_NAME         | Yes    | Yes      | CN of the group                                               |
| distinguishedName - OU Name     | OU_NAME            | Yes    | Yes      | OU in which the group resides                                 |
| groupType                       | GROUP_SCOPE        | No     | Yes      | Scope of the group (domain local, global, or universal)       |
| distinguishedName - Domain Name | DOMAIN_NAME        | No     | Yes      | Domain to which the group belongs                             |
| objectClass                     | OBJECT_CLASS       | No     | Yes      | Object class of the group (e.g., group)                       |
| distinguishedName               | DISTINGUISHED_NAME | No     | Yes      | DN of the group object                                        |
| whenCreated                     | CREATED_ON         | No     | Yes      | Date and time when the group was created                      |
| whenChanged                     | CHANGED_ON         | No     | Yes      | Date and time when the group was last modified                |
| objectGUID                      | OBJECT_GUID        | No     | Yes      | GUID of the group                                             |
| objectSID                       | SID_STRING         | No     | Yes      | SID of the group                                              |
| memberOf                        | MEMBER_OF          | No     | Yes      | Other groups of which this group is a member                  |
