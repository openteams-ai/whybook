# What an R kernel has, for an agent that writes cells in it: R's version,
# whether it reads parquet, and the packages installed.
#
# The R version of kernel_facts.py (design iteration 1.69). An agent that
# answers in a second notebook reads this when the notebook opens, so that it
# writes code with the packages there are and says which are missing. It
# installs nothing. It needs jsonlite and IRdisplay, which R kernels depend on.
.whybook_kernel_facts <- function(args) {
  installed <- sort(unique(rownames(utils::installed.packages())))
  IRdisplay::publish_mimebundle(list(
    "application/vnd.whybook.result+json" = list(
      language = paste("R", getRversion()),
      parquet = requireNamespace("arrow", quietly = TRUE),
      packages = as.list(utils::head(installed, 500))
    )
  ))
}
