(function () {
  "use strict";

  document.documentElement.classList.add("js");

  const LANGUAGE_KEY = "nabda-language";
  const THEME_KEY = "nabda-docs-theme";
  let currentLanguage = "en";

  const readPreference = (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  };

  const savePreference = (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch (_error) {
      // Preferences remain active for the current page when storage is unavailable.
    }
  };

  const applyLanguage = (language, persist) => {
    currentLanguage = language === "ar" ? "ar" : "en";
    const arabic = currentLanguage === "ar";
    const body = document.body;

    document.documentElement.lang = currentLanguage;
    document.documentElement.dir = arabic ? "rtl" : "ltr";
    document.title = arabic ? body.dataset.titleAr : body.dataset.titleEn;

    const description = document.querySelector('meta[name="description"]');
    if (description) description.content = arabic ? body.dataset.descriptionAr : body.dataset.descriptionEn;

    document.querySelectorAll("[data-en][data-ar]").forEach((element) => {
      element.textContent = arabic ? element.dataset.ar : element.dataset.en;
    });

    document.querySelectorAll("[data-en-html][data-ar-html]").forEach((element) => {
      element.innerHTML = arabic ? element.dataset.arHtml : element.dataset.enHtml;
    });

    document.querySelectorAll("[data-en-label][data-ar-label]").forEach((element) => {
      element.setAttribute("aria-label", arabic ? element.dataset.arLabel : element.dataset.enLabel);
    });

    document.querySelectorAll("[data-language]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.language === currentLanguage));
    });

    document.querySelectorAll("[data-search-input]").forEach((input) => {
      input.placeholder = arabic ? input.dataset.placeholderAr : input.dataset.placeholderEn;
    });

    if (persist) savePreference(LANGUAGE_KEY, currentLanguage);
    document.dispatchEvent(new CustomEvent("nabda:language", { detail: { language: currentLanguage } }));
  };

  const savedLanguage = readPreference(LANGUAGE_KEY);
  if (savedLanguage === "ar") {
    applyLanguage("ar", false);
  } else {
    document.querySelectorAll("[data-language]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.language === "en"));
    });
    document.querySelectorAll("[data-en-label]").forEach((element) => {
      element.setAttribute("aria-label", element.dataset.enLabel);
    });
  }

  document.querySelectorAll("[data-language]").forEach((button) => {
    button.addEventListener("click", () => applyLanguage(button.dataset.language, true));
  });

  const menuButton = document.querySelector("[data-menu-toggle]");
  const menu = document.querySelector("[data-site-menu]");
  if (menuButton && menu) {
    const closeMenu = () => {
      menuButton.setAttribute("aria-expanded", "false");
      menu.classList.remove("is-open");
    };
    menuButton.addEventListener("click", () => {
      const isOpen = menuButton.getAttribute("aria-expanded") === "true";
      menuButton.setAttribute("aria-expanded", String(!isOpen));
      menu.classList.toggle("is-open", !isOpen);
    });
    menu.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenu();
    });
  }

  const docsSidebarButton = document.querySelector("[data-docs-sidebar-toggle]");
  const docsSidebar = document.querySelector("[data-docs-sidebar]");
  if (docsSidebarButton && docsSidebar) {
    docsSidebarButton.addEventListener("click", () => {
      const isOpen = docsSidebarButton.getAttribute("aria-expanded") === "true";
      docsSidebarButton.setAttribute("aria-expanded", String(!isOpen));
      docsSidebar.classList.toggle("is-open", !isOpen);
    });
    docsSidebar.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => {
      docsSidebarButton.setAttribute("aria-expanded", "false");
      docsSidebar.classList.remove("is-open");
    }));
  }

  const preferredTheme = readPreference(THEME_KEY);
  document.documentElement.dataset.theme = preferredTheme === "dark" ? "dark" : "light";
  const themeButtons = document.querySelectorAll("[data-theme-toggle]");
  const renderThemeButtons = () => {
    const isDark = document.documentElement.dataset.theme === "dark";
    themeButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(isDark));
      const label = currentLanguage === "ar"
        ? (isDark ? "استخدم المظهر الفاتح" : "استخدم المظهر الداكن")
        : (isDark ? "Use light theme" : "Use dark theme");
      button.setAttribute("aria-label", label);
      button.title = label;
    });
  };
  themeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = nextTheme;
      savePreference(THEME_KEY, nextTheme);
      renderThemeButtons();
    });
  });
  document.addEventListener("nabda:language", renderThemeButtons);
  renderThemeButtons();

  document.querySelectorAll("[data-copy-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.dataset.copyTarget);
      if (!target) return;
      const original = currentLanguage === "ar" ? "نسخ" : "Copy";
      try {
        await navigator.clipboard.writeText(target.textContent.trim());
        button.textContent = currentLanguage === "ar" ? "تم النسخ" : "Copied";
      } catch (_error) {
        button.textContent = currentLanguage === "ar" ? "تعذر النسخ" : "Copy failed";
      }
      window.setTimeout(() => { button.textContent = original; }, 1600);
    });
  });

  const searchInput = document.querySelector("[data-search-input]");
  const searchResults = document.querySelector("[data-search-results]");
  if (searchInput && searchResults) {
    const sections = Array.from(document.querySelectorAll("[data-doc-search-item]"));
    const closeResults = () => {
      searchResults.hidden = true;
      searchResults.replaceChildren();
    };
    const renderResults = () => {
      const query = searchInput.value.trim().toLocaleLowerCase(currentLanguage);
      searchResults.replaceChildren();
      if (!query) {
        closeResults();
        return;
      }
      const matches = sections.filter((section) => {
        const title = currentLanguage === "ar" ? section.dataset.searchTitleAr : section.dataset.searchTitleEn;
        const keywords = currentLanguage === "ar" ? section.dataset.searchKeywordsAr : section.dataset.searchKeywordsEn;
        return `${title} ${keywords} ${section.textContent}`.toLocaleLowerCase(currentLanguage).includes(query);
      }).slice(0, 8);
      const status = document.createElement("p");
      status.className = "search-status";
      status.textContent = matches.length
        ? (currentLanguage === "ar" ? `${matches.length} نتائج` : `${matches.length} result${matches.length === 1 ? "" : "s"}`)
        : (currentLanguage === "ar" ? "لا توجد نتائج. جرّب كلمة أخرى." : "No results. Try another term.");
      searchResults.append(status);
      matches.forEach((section) => {
        const link = document.createElement("a");
        link.href = `#${section.id}`;
        link.className = "search-result";
        const title = document.createElement("strong");
        title.textContent = currentLanguage === "ar" ? section.dataset.searchTitleAr : section.dataset.searchTitleEn;
        const path = document.createElement("span");
        path.textContent = `Help / ${section.dataset.searchGroup || "Guide"}`;
        link.append(title, path);
        link.addEventListener("click", () => {
          closeResults();
          searchInput.value = "";
        });
        searchResults.append(link);
      });
      searchResults.hidden = false;
    };
    searchInput.addEventListener("input", renderResults);
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeResults();
      if (event.key === "Enter") {
        const first = searchResults.querySelector("a");
        if (first) first.click();
      }
    });
    document.addEventListener("click", (event) => {
      if (!searchResults.contains(event.target) && event.target !== searchInput) closeResults();
    });
    document.addEventListener("nabda:language", renderResults);

    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
    });
  }

  const docsSections = Array.from(document.querySelectorAll(".docs-section[id]"));
  if (docsSections.length && "IntersectionObserver" in window) {
    const sectionLinks = Array.from(document.querySelectorAll('.docs-sidebar a[href^="#"], .docs-toc a[href^="#"]'));
    const sectionObserver = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
      if (!visible) return;
      sectionLinks.forEach((link) => {
        link.classList.toggle("is-active", link.getAttribute("href") === `#${visible.target.id}`);
      });
    }, { rootMargin: "-18% 0px -68%", threshold: 0 });
    docsSections.forEach((section) => sectionObserver.observe(section));
  }

  document.querySelectorAll("[data-code-demo]").forEach((demo) => {
    const tabs = Array.from(demo.querySelectorAll("[data-code-tab]"));
    const panels = Array.from(demo.querySelectorAll("[data-code-panel]"));
    if (!tabs.length || !panels.length) return;

    const activateTab = (tab, focus) => {
      const panelName = tab.dataset.codeTab;
      tabs.forEach((candidate) => {
        const active = candidate === tab;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-selected", String(active));
        candidate.tabIndex = active ? 0 : -1;
      });
      panels.forEach((panel) => {
        panel.hidden = panel.dataset.codePanel !== panelName;
      });
      if (focus) tab.focus();
    };

    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => activateTab(tab, false));
      tab.addEventListener("keydown", (event) => {
        let nextIndex = null;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;
        if (nextIndex === null) return;
        event.preventDefault();
        activateTab(tabs[nextIndex], true);
      });
    });
  });

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const motionScenes = Array.from(document.querySelectorAll("[data-motion]"));
  const flowDemos = Array.from(document.querySelectorAll("[data-flow-demo]"));

  const flowStepCount = (demo) => {
    const configuredCount = Number.parseInt(demo.dataset.flowSteps || "", 10);
    if (Number.isInteger(configuredCount) && configuredCount > 0) return configuredCount;
    const steps = Array.from(demo.querySelectorAll("[data-sequence-step]"))
      .map((element) => Number.parseInt(element.dataset.sequenceStep || "", 10))
      .filter(Number.isInteger);
    return steps.length ? Math.max(...steps) + 1 : 1;
  };

  const setFlowStep = (demo, nextStep) => {
    const count = flowStepCount(demo);
    const normalizedStep = ((nextStep % count) + count) % count;
    demo.dataset.flowStep = String(normalizedStep);
    demo.querySelectorAll("[data-flow-jump]").forEach((control) => {
      const active = Number.parseInt(control.dataset.flowJump || "", 10) === normalizedStep;
      control.classList.toggle("is-active", active);
      control.setAttribute("aria-pressed", String(active));
    });
  };

  flowDemos.forEach((demo) => {
    setFlowStep(demo, Number.parseInt(demo.dataset.flowStep || "0", 10));
    demo.querySelectorAll("[data-flow-jump]").forEach((control) => {
      control.addEventListener("click", () => {
        const step = Number.parseInt(control.dataset.flowJump || "0", 10);
        demo.dataset.manualUntil = String(Date.now() + 5000);
        setFlowStep(demo, step);
      });
    });
  });

  if ("IntersectionObserver" in window) {
    const motionObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        entry.target.classList.toggle("is-motion-paused", !entry.isIntersecting);
      });
    }, { rootMargin: "80px 0px", threshold: .08 });
    motionScenes.forEach((scene) => motionObserver.observe(scene));
  }

  const syncDocumentVisibility = () => {
    document.documentElement.classList.toggle("is-document-hidden", document.hidden);
  };
  document.addEventListener("visibilitychange", syncDocumentVisibility);
  syncDocumentVisibility();

  const applyMotionPreference = () => {
    document.documentElement.classList.toggle("has-reduced-motion", reducedMotion.matches);
    if (reducedMotion.matches) {
      flowDemos.forEach((demo) => setFlowStep(demo, flowStepCount(demo) - 1));
    }
  };
  if (typeof reducedMotion.addEventListener === "function") {
    reducedMotion.addEventListener("change", applyMotionPreference);
  } else if (typeof reducedMotion.addListener === "function") {
    reducedMotion.addListener(applyMotionPreference);
  }
  applyMotionPreference();

  const advanceFlowDemos = () => {
    if (document.hidden || reducedMotion.matches) return;
    const now = Date.now();
    flowDemos.forEach((demo) => {
      if (demo.classList.contains("is-motion-paused")) return;
      if (Number.parseInt(demo.dataset.manualUntil || "0", 10) > now) return;
      const currentStep = Number.parseInt(demo.dataset.flowStep || "0", 10);
      setFlowStep(demo, currentStep + 1);
    });
  };

  if (flowDemos.length) window.setInterval(advanceFlowDemos, 1850);

  document.querySelectorAll("[data-current-year]").forEach((year) => {
    year.textContent = String(new Date().getFullYear());
  });
})();
