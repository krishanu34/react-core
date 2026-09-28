# TELCO-6117 provisional Selenium automation

**Source:** User-provided TELCO-6117 acceptance criteria and approved automation scope  
**Stack:** Python, pytest, Selenium WebDriver, Chrome

## Execute

```cmd
cd automation\telco_6117
py -m pip install -r requirements.txt
set CONTACT_US_BASE_URL=https://test.example.invalid
set SELENIUM_HEADLESS=true
py -m pytest
```

`CONTACT_US_BASE_URL` is mandatory. The page object navigates to `/contact-us` beneath this base URL.

## Automated traceability

| Test | Requirement | Technique | Coverage |
|---|---|---|---|
| `test_customer_can_select_contact_option_and_continue` | AC-1 | Equivalence Partitioning | Select first displayed contact option and continue flow. |
| `test_customer_can_handoff_to_available_human_agent` | AC-5 | State Transition | Flow to agent-connected state. |
| `test_customer_is_given_fallback_when_agent_handoff_is_unavailable` | AC-5 | State Transition | Flow to unavailable state and fallback presentation. |

## Required implementation mapping

Replace every provisional `data-testid` locator in `pages/contact_us_page.py` with application-owned selectors. Configure test-environment agent capacity before each AC-5 test:

- **Available test:** agent hand-off resolves to the agent-connected state.
- **Unavailable test:** agent hand-off resolves to the unavailable state with a fallback option.

## Deliberately excluded coverage

The ticket has no executable response target (AC-1), wait-time baseline/target (AC-2), accessibility standard (AC-3), brand reference (AC-4), peak-load profile, or PII policy. Those requirements remain documented but are not automated as pass/fail checks.
