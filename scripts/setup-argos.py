"""Install the English/Chinese Argos Translate packages for one CI run."""

import argostranslate.package
import argostranslate.translate


def installed_pairs():
    pairs = set()
    for language in argostranslate.translate.get_installed_languages():
        for translation in language.translations_from:
            pairs.add((translation.from_lang.code, translation.to_lang.code))
    return pairs


argostranslate.package.update_package_index()
available = argostranslate.package.get_available_packages()
installed = installed_pairs()

for source, target in (("en", "zh"), ("zh", "en")):
    if (source, target) in installed:
        print(f"Argos package already installed: {source}->{target}")
        continue
    candidates = [
        item for item in available
        if item.from_code == source and item.to_code == target
    ]
    if not candidates:
        raise SystemExit(f"Argos package not found: {source}->{target}")
    package_path = candidates[0].download()
    argostranslate.package.install_from_path(package_path)
    print(f"Installed Argos package: {source}->{target}")
