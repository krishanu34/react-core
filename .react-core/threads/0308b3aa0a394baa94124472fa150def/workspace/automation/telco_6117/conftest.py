"""Shared Selenium fixtures for provisional TELCO-6117 automation."""

import os

import pytest
from selenium import webdriver
from selenium.webdriver.chrome.options import Options


@pytest.fixture
def base_url() -> str:
    """Return the Contact us test URL supplied by the execution environment."""
    url = os.getenv("CONTACT_US_BASE_URL")
    if not url:
        pytest.fail(
            "CONTACT_US_BASE_URL is required. Set it to the Contact us test/staging URL."
        )
    return url.rstrip("/")


@pytest.fixture
def driver():
    """Provide a Chrome WebDriver; set SELENIUM_HEADLESS=true for CI."""
    options = Options()
    if os.getenv("SELENIUM_HEADLESS", "false").lower() == "true":
        options.add_argument("--headless=new")
    options.add_argument("--window-size=1440,1000")

    browser = webdriver.Chrome(options=options)
    browser.implicitly_wait(0)
    yield browser
    browser.quit()
