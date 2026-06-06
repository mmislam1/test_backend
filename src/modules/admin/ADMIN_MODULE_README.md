# Admin Module Documentation

## Overview

The Admin Module provides comprehensive management endpoints for site administrators. All endpoints require authentication (JWT token) and admin role verification.

## Architecture

### Files Created

```
src/
├── common/middlewares/
│   └── admin.middleware.ts          # Admin role verification middleware
├── modules/admin/
│   ├── admin.controller.ts          # Business logic for all endpoints
│   ├── admin.routes.ts              # Route definitions
│   └── admin.types.ts               # TypeScript interfaces and types
└── app.ts                           # Updated with admin routes
```

### Security

- **Authentication**: All routes use `authMiddleware` to verify valid JWT token
- **Authorization**: All routes use `isAdminMiddleware` to verify admin role
- Every request is independently checked for admin privileges

## API Endpoints

### Base URL
```
/api/v1/admin
```

### 1. Dashboard Statistics
**Endpoint**: `GET /dashboard`

Returns comprehensive dashboard statistics including content metrics, user metrics, and recent activities.

**Response**:
```json
{
  "success": true,
  "data": {
    "totalContent": 1250,
    "underAnalysis": 45,
    "analysisComplete": 1200,
    "memberCount": 350,
    "activeSubscriptions": 127,
    "searchesToday": 89,
    "revenueThisMonth": 4250.50,
    "recentActivity": [
      {
        "type": "search|subscription|user_joined|payment",
        "userId": "user_id",
        "userName": "John Doe",
        "userEmail": "john@example.com",
        "timestamp": "2026-04-20T10:30:00Z",
        "description": "Activity description",
        "details": {}
      }
    ]
  }
}
```

---

### 2. Users List with Pagination
**Endpoint**: `GET /users?page=1&limit=10&status=active&search=john`

Returns paginated list of all users with filtering options.

**Query Parameters**:
- `page` (number, default: 1) - Page number
- `limit` (number, default: 10, max: 100) - Items per page
- `status` (string, optional) - Filter by status: `active` or `inactive`
- `search` (string, optional) - Search by name

**Response**:
```json
{
  "success": true,
  "data": {
    "data": [
      {
        "_id": "user_id",
        "name": "John Doe",
        "email": "john@example.com",
        "status": "active",
        "subscription": {
          "tier": "pro",
          "status": "active"
        },
        "joiningDate": "2026-01-15T00:00:00Z",
        "searchCount": 25
      }
    ],
    "pagination": {
      "total": 350,
      "page": 1,
      "limit": 10,
      "pages": 35
    }
  }
}
```

---

### 3. User Detailed Information
**Endpoint**: `GET /userDetails/:userId`

Returns complete information for a specific user including subscription and recent searches.

**Parameters**:
- `userId` (URL param) - MongoDB user ID

**Response**:
```json
{
  "success": true,
  "data": {
    "_id": "user_id",
    "name": "John Doe",
    "email": "john@example.com",
    "phoneNumber": "+1234567890",
    "joiningDate": "2026-01-15T00:00:00Z",
    "role": "general",
    "isActive": true,
    "isApproved": true,
    "credits": 8500,
    "monitors": 3,
    "subscriptionId": "sub_id",
    "subscription": {
      "planId": "plan_id",
      "status": "active",
      "billingCycle": "monthly"
    },
    "searchCount": 25,
    "searches": [
      {
        "_id": "search_id",
        "image": "https://...",
        "status": "completed",
        "date": "2026-04-20T10:30:00Z"
      }
    ],
    "referralCode": "ABC123",
    "referralCount": 5
  }
}
```

---

### 4. User Searches Paginated List
**Endpoint**: `GET /userSearches/:userId?page=1&limit=10`

Returns paginated list of searches for a specific user.

**Parameters**:
- `userId` (URL param) - MongoDB user ID
- `page` (query, default: 1) - Page number
- `limit` (query, default: 10) - Items per page

**Response**:
```json
{
  "success": true,
  "data": {
    "data": [
      {
        "_id": "search_id",
        "image": "https://cloudinary.com/...",
        "status": "completed",
        "date": "2026-04-20T10:30:00Z"
      }
    ],
    "pagination": {
      "total": 25,
      "page": 1,
      "limit": 10,
      "pages": 3
    }
  }
}
```

---

### 5. Deactivate User
**Endpoint**: `POST /deactivate/:userId`

Deactivates a user account (sets `isActive` to false).

**Parameters**:
- `userId` (URL param) - MongoDB user ID

**Request Body**:
```json
{
  "reason": "Policy violation (optional)"
}
```

**Response**:
```json
{
  "success": true,
  "message": "User john@example.com has been deactivated",
  "data": {
    "userId": "user_id",
    "email": "john@example.com",
    "isActive": false
  }
}
```

---

### 6. All Searches List with Filtering
**Endpoint**: `GET /searches?page=1&limit=10&status=completed&userName=john`

Returns paginated list of all searches across all users with filtering.

**Query Parameters**:
- `page` (number, default: 1) - Page number
- `limit` (number, default: 10, max: 100) - Items per page
- `status` (string, optional) - Filter by status: `processing`, `completed`, `failed`, `reviewPending`
- `userName` (string, optional) - Filter by uploader name (case-insensitive)

**Response**:
```json
{
  "success": true,
  "data": {
    "data": [
      {
        "_id": "search_id",
        "image": "https://cloudinary.com/search_queries/image.jpg",
        "fileName": "image.jpg",
        "uploaderId": "user_id",
        "uploaderName": "John Doe",
        "status": "completed",
        "discoveryCount": 42,
        "uploadDate": "2026-04-20T10:30:00Z"
      }
    ],
    "pagination": {
      "total": 1250,
      "page": 1,
      "limit": 10,
      "pages": 125
    }
  }
}
```

---

### 7. Get Search Details
**Endpoint**: `GET /searchDetails/:searchId`

Returns detailed information for a specific search including the search document, its status, and associated results (paginated).

**Route protections**: `authMiddleware`, `isAdminMiddleware` — admin-only endpoint

**URL Params**:
- `searchId` (string, required) - MongoDB search ID

**Query Parameters**:
- `page` (number, optional) - Results page number (default: 1)
- `limit` (number, optional) - Items per page (default: 10, max: 100)

**Response**:
```json
{
  "success": true,
  "data": {
    "_id": "search_id",
    "image": "https://...",
    "status": "completed",
    "uploader": {
      "_id": "user_id",
      "name": "John Doe",
      "email": "john@example.com"
    },
    "date": "2026-04-20T10:30:00Z",
    "nextRescanAt": null,
    "lastRescanAt": null,
    "results": {
      "data": [
        {
          "_id": "result_id",
          "image": "https://...",
          "reviewStatus": "not_reviewed",
          "reviewedAt": null,
          "details": {}
        }
      ],
      "pagination": {
        "total": 42,
        "page": 1,
        "limit": 10,
        "pages": 5
      }
    }
  }
}
```

## Usage Examples

### Example 1: Get Dashboard
```bash
curl -X GET http://localhost:5000/api/v1/admin/dashboard \
  -H "Authorization: Bearer your_jwt_token"
```

### Example 2: Get Active Users (Paginated)
```bash
curl -X GET "http://localhost:5000/api/v1/admin/users?page=1&limit=20&status=active" \
  -H "Authorization: Bearer your_jwt_token"
```

### Example 3: Search All Completed Searches
```bash
curl -X GET "http://localhost:5000/api/v1/admin/searches?status=completed&page=1&limit=50" \
  -H "Authorization: Bearer your_jwt_token"
```

### Example 4: Get User Details
```bash
curl -X GET http://localhost:5000/api/v1/admin/userDetails/60d5ec49c1234567890abcde \
  -H "Authorization: Bearer your_jwt_token"
```

### Example 5: Deactivate User
```bash
curl -X POST http://localhost:5000/api/v1/admin/deactivate/60d5ec49c1234567890abcde \
  -H "Authorization: Bearer your_jwt_token" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Suspicious activity"}'
```

---

## Error Responses

### Unauthorized (Missing Token)
```json
{
  "success": false,
  "error": {
    "message": "Authentication required"
  }
}
```
**Status**: 401

### Forbidden (Not Admin)
```json
{
  "success": false,
  "error": {
    "message": "Admin access required"
  }
}
```
**Status**: 403

### Not Found
```json
{
  "success": false,
  "error": "User not found"
}
```
**Status**: 404

### Server Error
```json
{
  "success": false,
  "error": "Failed to fetch dashboard statistics"
}
```
**Status**: 500

---

## Middleware Details

### Auth Middleware (`authMiddleware`)
- Checks for JWT token in `Authorization: Bearer <token>` header
- Verifies token validity using JWT_SECRET
- Sets `req.user` with userId and isPro flag
- Returns 401 if token is missing or invalid

### Admin Middleware (`isAdminMiddleware`)
- Must be used AFTER `authMiddleware`
- Verifies user exists in database
- Checks if user role is `admin`
- Returns 403 if user is not admin
- Returns 401 if user not found

---

## Data Models Used

### User Model
- name, email, status (isActive), subscription info
- joiningDate, credits, monitors
- referralCode, referralCount

### Search Model
- userId, image, status, date
- folderId, nextRescanAt, lastRescanAt

### Result Model
- searchId, image, details
- reviewStatus, reviewedAt

### Subscription Model
- userId, planId, status, billingCycle
- activationDate, cancelDate, currentPeriodEnd

### Payment Model
- userId, subscriptionId, amount, status, createdAt

---

## Integration

The admin routes are already integrated into `app.ts`:
```typescript
app.use('/api/v1/admin', adminRouter);
```

All admin endpoints are available at:
```
http://localhost:PORT/api/v1/admin/[endpoint]
```

---

## Notes

- Pagination defaults: page=1, limit=10, max limit=100
- All timestamps are in ISO 8601 format
- Recent activity includes up to 20 latest activities across all types
- Search discovery count is calculated by aggregating Result documents
- User search count is calculated by aggregating Search documents per user
- All responses follow a consistent format with `success` flag and `data` object
