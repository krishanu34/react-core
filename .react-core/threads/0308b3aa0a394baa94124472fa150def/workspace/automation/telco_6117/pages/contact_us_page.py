"""Page object for TELCO-6117 Contact us flow.

All locators are provisional data-testid placeholders and must be mapped to the
implemented UI before the suite is used as a release gate.
"""

from selenium.webdriver.common.by import By
from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


class ContactUsPage:
    # TODO: Replace these placeholder selectors with application-owned selectors.
    FLOW_ROOT = (By.CSS_SELECTOR, '[data-testid="contact-us-flow"]')
    CONTACT_OPTION = (By.CSS_SELECTOR, '[data-testid="contact-option"]')
    CONTINUE_BUTTON = (By.CSS_SELECTOR, '[data-testid="contact-us-continue"]')
    AGENT_HANDOFF_BUTTON = (By.CSS_SELECTOR, '[data-testid="handoff-to-agent"]')
    AGENT_CONNECTED = (By.CSS_SELECTOR, '[data-testid="agent-connected"]')
    HANDOFF_UNAVAILABLE = (By.CSS_SELECTOR, '[data-testid="handoff-unavailable"]')
    FALLBACK_OPTION = (By.CSS_SELECTOR, '[data-testid="handoff-fallback"]')

    def __init__(self, driver: WebDriver, timeout_seconds: int = 15) -> None:
        self.driver = driver
        self.wait = WebDriverWait(driver, timeout_seconds)

    def open(self, base_url: str) -> None:
        self.driver.get(f"{base_url}/contact-us")
        self.wait.until(EC.visibility_of_element_located(self.FLOW_ROOT))

    def choose_first_contact_option(self) -> None:
        options = self.wait.until(EC.visibility_of_all_elements_located(self.CONTACT_OPTION))
        options[0].click()

    def continue_flow(self) -> None:
        self.wait.until(EC.element_to_be_clickable(self.CONTINUE_BUTTON)).click()

    def request_agent_handoff(self) -> None:
        self.wait.until(EC.element_to_be_clickable(self.AGENT_HANDOFF_BUTTON)).click()

    def agent_connection_is_displayed(self) -> bool:
        return self.wait.until(EC.visibility_of_element_located(self.AGENT_CONNECTED)).is_displayed()

    def handoff_unavailable_message_is_displayed(self) -> bool:
        return self.wait.until(EC.visibility_of_element_located(self.HANDOFF_UNAVAILABLE)).is_displayed()

    def fallback_option_is_displayed(self) -> bool:
        return self.wait.until(EC.visibility_of_element_located(self.FALLBACK_OPTION)).is_displayed()
