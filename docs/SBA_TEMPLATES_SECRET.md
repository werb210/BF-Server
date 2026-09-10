# BF_SERVER_SBA_TEMPLATES_IN_CI_v1

`sbaRealTemplateFill.v130` fills the three official SBA PDFs and reads the
values back off the page. It is the only SBA test that proves a value reaches
the form; the other 27 files assert against source text, which is how a form
once shipped with four blank mandatory answers and passed all of them.

The templates are deliberately not committed. To let CI run these checks:

    cd <folder holding the three PDFs>
    tar -czf sba-templates.tar.gz \
      sba-form-1919-02-2025.pdf \
      sba-form-413-05-2024.pdf \
      sba-form-912-12-2028.pdf
    base64 -i sba-templates.tar.gz | pbcopy

Paste into GitHub → BF-Server → Settings → Secrets and variables → Actions →
New repository secret, named `SBA_TEMPLATES_TARBALL_B64`.

Without the secret the CI step is skipped and the tests skip as before, so
nothing breaks by not setting it. Re-create the secret whenever the SBA
publishes a new revision of a form; the filenames carry the revision date and
the test asserts on them.
