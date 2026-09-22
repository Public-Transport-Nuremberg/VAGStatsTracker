use anyhow::{Context, Result};
use chrono::NaiveDate;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut cutoff = None;
    let mut input = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--train-until" => {
                cutoff = Some(
                    args.next()
                        .context("--train-until needs YYYY-MM-DD")?
                        .parse::<NaiveDate>()?,
                )
            }
            "--input" => input = Some(args.next().context("--input needs CSV path")?),
            "--help" | "-h" => {
                println!("router-backtest --train-until YYYY-MM-DD --input observations.csv\nCSV columns: date,predicted_probability,succeeded");
                return Ok(());
            }
            _ => anyhow::bail!("unknown argument {arg}"),
        }
    }
    let report = reliability::backtest::calibrate_csv(
        cutoff.context("missing --train-until")?,
        std::fs::File::open(input.context("missing --input")?)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
