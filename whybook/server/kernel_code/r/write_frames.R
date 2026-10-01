# Write data frames of the kernel to files that a notebook of another kernel reads.
#
# The R version of write_frames.py (design iteration 1.69): an agent that
# answers in a second notebook has the analyst's kernel write the frames that
# the cells to port read, into a folder beside the notebooks. Parquet needs
# the arrow package here, and a reader there; CSV needs neither.
# `args$format` is "parquet" when the other kernel reads parquet; without
# arrow here, a frame goes as CSV. It needs jsonlite and IRdisplay, which R
# kernels depend on.
.whybook_write_frames <- function(args) {
  folder <- if (is.null(args$folder)) "from_r" else as.character(args$folder)
  wanted <- if (identical(args$format, "parquet")) "parquet" else "csv"
  files <- list()
  errors <- list()
  for (name in as.character(unlist(args$frames))) {
    if (!exists(name, envir = globalenv(), inherits = FALSE)) {
      errors[[length(errors) + 1]] <- list(frame = name, error = paste("no variable named", name))
      next
    }
    value <- get(name, envir = globalenv())
    if (!is.data.frame(value)) {
      errors[[length(errors) + 1]] <- list(frame = name, error = paste(name, "is not a data frame"))
      next
    }
    format <- if (wanted == "parquet" && requireNamespace("arrow", quietly = TRUE)) "parquet" else "csv"
    path <- file.path(folder, paste0(name, ".", format))
    existed <- file.exists(path)
    written <- tryCatch(
      {
        dir.create(folder, showWarnings = FALSE, recursive = TRUE)
        if (format == "parquet") {
          arrow::write_parquet(value, path)
        } else {
          utils::write.csv(value, path, row.names = FALSE)
        }
        TRUE
      },
      error = function(e) {
        errors[[length(errors) + 1]] <<- list(frame = name, error = conditionMessage(e))
        FALSE
      }
    )
    if (!written) {
      next
    }
    columns <- lapply(utils::head(names(value), 200), function(column) {
      list(name = column, type = class(value[[column]])[1])
    })
    files[[length(files) + 1]] <- list(
      frame = name,
      path = path,
      format = format,
      rows = nrow(value),
      columns = columns,
      existed = existed
    )
  }
  IRdisplay::publish_mimebundle(list(
    "application/vnd.whybook.result+json" = list(folder = folder, files = files, errors = errors)
  ))
}
