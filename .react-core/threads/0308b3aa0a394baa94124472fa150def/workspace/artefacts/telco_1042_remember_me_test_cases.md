# TELCO-1042 — Remember me: Functional Test Cases

**Priority:** Medium  
**Component:** Web Account Portal  
**Source:** User-provided TELCO-1042 brief (2026-09-22)

## Traceability

| Requirement | Source | Test cases |
|---|---|---|
| AC-1 — Checkbox is left of Sign in and unchecked by default | Acceptance criterion 1 | TC-001 |
| AC-2 — Selected checkbox produces a 30-day expiry | Acceptance criterion 2 | TC-002, TC-005 |
| AC-3 — Unselected checkbox preserves browser-session behaviour | Acceptance criterion 3 | TC-003, TC-006 |
| AC-4 — Checkbox selection is not remembered between visits | Acceptance criterion 4 | TC-004 |
| NFR-1 — Cookie carries Secure and HttpOnly | Non-functional requirement 1 | TC-005, TC-006 |
| NFR-2 — No identity-provider handshake change | Non-functional requirement 2 | TC-007 |

## Test data and observability

- **Valid customer:** An active portal customer account with valid credentials.
- **Session cookie:** Identify the portal session cookie from the sign-in response or browser cookie store; the ticket does not specify its name.
- **Time reference:** Record current date/time immediately before or at cookie issuance using the agreed test-environment clock.

---

## TC-TELCO-1042-001 — Display Remember me to the left of Sign in and leave it unchecked by default

- **Requirements:** AC-1
- **Technique:** UI/layout oracle
- **Source:** TELCO-1042 acceptance criterion 1

**Preconditions**
- The sign-in form is available in a test environment.
- No previously rendered page is relied upon.

**Steps**
1. Open the sign-in page.
2. Locate the **Remember me** checkbox and the **Sign in** button.
3. Compare their displayed positions.
4. Inspect the initial selection state of the checkbox.

**Expected results**
- A checkbox labelled **Remember me** is displayed.
- The checkbox is positioned to the left of the **Sign in** button.
- The checkbox is unchecked when the sign-in page initially renders.

---

## TC-TELCO-1042-002 — Issue a 30-day session cookie when Remember me is selected

- **Requirements:** AC-2
- **Technique:** Boundary Value Analysis (BVA)
- **Source:** TELCO-1042 acceptance criterion 2

**Preconditions**
- A valid customer account is available.
- Cookie attributes can be inspected in the sign-in response or browser cookie store.
- The test-environment current date/time can be recorded.

**Steps**
1. Open the sign-in page.
2. Select **Remember me**.
3. Record the current date/time immediately before submitting valid credentials.
4. Submit the sign-in form.
5. Identify the issued portal session cookie and inspect its expiry value.
6. Calculate the interval from the recorded issuance time to the cookie expiry.

**Expected results**
- The selected sign-in completes according to the existing sign-in outcome.
- The issued portal session cookie has an expiry set to 30 days from the current date/time.
- Assess the expiry at the 30-day boundary using the agreed clock precision; no alternate duration is accepted.

---

## TC-TELCO-1042-003 — Preserve browser-session cookie behaviour when Remember me is unselected

- **Requirements:** AC-3
- **Technique:** Equivalence Partitioning (EP)
- **Source:** TELCO-1042 acceptance criterion 3

**Preconditions**
- A valid customer account is available.
- Cookie attributes can be inspected in the sign-in response or browser cookie store.

**Steps**
1. Open the sign-in page.
2. Leave **Remember me** unselected.
3. Submit valid customer credentials.
4. Identify and inspect the issued portal session cookie.
5. Close the browser session.
6. Start a new browser session and visit the portal.

**Expected results**
- The issued portal session cookie retains browser-session behaviour and has no persistent expiry applicable beyond browser close.
- After the browser session is closed, the portal session is no longer available in the new browser session.

---

## TC-TELCO-1042-004 — Reset Remember me to unchecked on a subsequent sign-in-page visit

- **Requirements:** AC-4
- **Technique:** State-Transition Testing
- **Source:** TELCO-1042 acceptance criterion 4

**Preconditions**
- The sign-in page is available.
- A valid customer account is available for the selected-sign-in path.

**Steps**
1. Open the sign-in page and select **Remember me**.
2. Sign in with valid credentials.
3. Return to the sign-in page in a subsequent visit by ending the authenticated journey or using an available sign-out path.
4. Inspect the checkbox when the page loads.
5. Refresh the sign-in page and inspect the checkbox again.

**Expected results**
- The checkbox renders unchecked on the subsequent sign-in-page load despite prior selection.
- The checkbox renders unchecked after the page refresh.

---

## TC-TELCO-1042-005 — Apply Secure and HttpOnly to the persistent session cookie

- **Requirements:** AC-2, NFR-1
- **Technique:** Security-attribute inspection
- **Sources:** TELCO-1042 acceptance criterion 2; non-functional requirement 1

**Preconditions**
- A valid customer account is available.
- The sign-in response or browser developer tooling exposes session-cookie attributes.

**Steps**
1. Open the sign-in page.
2. Select **Remember me** and submit valid credentials.
3. Identify the issued portal session cookie.
4. Inspect its **Secure** and **HttpOnly** attributes.

**Expected results**
- The selected-path session cookie carries the **Secure** flag.
- The same cookie carries the **HttpOnly** flag.

---

## TC-TELCO-1042-006 — Apply Secure and HttpOnly to the browser-session cookie

- **Requirements:** AC-3, NFR-1
- **Technique:** Decision-table testing
- **Sources:** TELCO-1042 acceptance criterion 3; non-functional requirement 1

**Preconditions**
- A valid customer account is available.
- The sign-in response or browser developer tooling exposes session-cookie attributes.

**Steps**
1. Open the sign-in page.
2. Leave **Remember me** unselected and submit valid credentials.
3. Identify the issued portal session cookie.
4. Inspect its **Secure** and **HttpOnly** attributes.

**Expected results**
- The unselected-path session cookie carries the **Secure** flag.
- The same cookie carries the **HttpOnly** flag.
- This path remains a browser-session cookie as specified in AC-3.

---

## TC-TELCO-1042-007 — Verify the identity-provider handshake is unchanged for both Remember me selections

- **Requirements:** NFR-2
- **Technique:** Regression oracle comparison
- **Source:** TELCO-1042 non-functional requirement 2

**Preconditions**
- A baseline capture or approved observable definition of the pre-change identity-provider handshake is available.
- A valid customer account is available.
- Network or identity-provider observability is available for both sign-in attempts.

**Steps**
1. Capture or obtain the approved baseline identity-provider handshake for a portal sign-in.
2. Sign in with **Remember me** selected and capture the identity-provider handshake.
3. Sign in with **Remember me** unselected and capture the identity-provider handshake.
4. Compare each captured handshake with the approved baseline using the agreed comparison method.

**Expected results**
- The identity-provider handshake for the selected path is unchanged from the approved baseline.
- The identity-provider handshake for the unselected path is unchanged from the approved baseline.
- Cookie persistence is assessed separately through AC-2 and AC-3 and is not treated as an identity-provider handshake change.

## Execution dependencies

1. The ticket does not name the session cookie or prescribe its inspection method.
2. The ticket does not define time-source precision or a permitted measurement tolerance for the 30-day expiry.
3. The handshake-regression test requires an approved baseline capture or observable definition of the current identity-provider handshake.
