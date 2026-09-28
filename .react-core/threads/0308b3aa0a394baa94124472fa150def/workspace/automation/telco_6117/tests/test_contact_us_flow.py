"""Provisional Selenium coverage for TELCO-6117.

The agent-service state must be configured by the test environment before
running either hand-off scenario. The current ticket does not define the setup
mechanism, routing rules, or context-transfer contract.
"""

import pytest

from pages.contact_us_page import ContactUsPage


@pytest.mark.telco_6117
@pytest.mark.ac1
@pytest.mark.equivalence_partitioning
def test_customer_can_select_contact_option_and_continue(driver, base_url):
    """TC-TELCO-6117-001 | AC-1 | EP: implemented contact option."""
    contact_us = ContactUsPage(driver)

    contact_us.open(base_url)
    contact_us.choose_first_contact_option()
    contact_us.continue_flow()

    assert contact_us.driver.current_url.startswith(base_url)


@pytest.mark.telco_6117
@pytest.mark.ac5
@pytest.mark.state_transition
def test_customer_can_handoff_to_available_human_agent(driver, base_url):
    """TC-TELCO-6117-005 | AC-5 | State: flow -> agent connected.

    Precondition: configure the test environment so an agent is available.
    """
    contact_us = ContactUsPage(driver)

    contact_us.open(base_url)
    contact_us.request_agent_handoff()

    assert contact_us.agent_connection_is_displayed()


@pytest.mark.telco_6117
@pytest.mark.ac5
@pytest.mark.state_transition
def test_customer_is_given_fallback_when_agent_handoff_is_unavailable(driver, base_url):
    """TC-TELCO-6117-006 | AC-5 | State: flow -> hand-off unavailable -> fallback.

    Precondition: configure the test environment so hand-off is unavailable.
    """
    contact_us = ContactUsPage(driver)

    contact_us.open(base_url)
    contact_us.request_agent_handoff()

    assert contact_us.handoff_unavailable_message_is_displayed()
    assert contact_us.fallback_option_is_displayed()
